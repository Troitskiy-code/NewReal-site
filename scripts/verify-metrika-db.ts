/**
 * Isolated upgrade check: historical PaymentEvent without analytics columns,
 * then apply 20261001210000. Never uses production DATABASE_URL and never
 * kills processes on a shared port.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { resolveIsolatedTestDatabaseUrl, SYNTHETIC_LOCAL_TEST_URL } from "./testDatabaseUrl.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = join(root, "prisma/migrations/20261001210000_payment_event_analytics/migration.sql");
const HIST_TABLE = `
  CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
  )
`;
const HIST_INDEX = `CREATE UNIQUE INDEX "PaymentEvent_provider_invoiceId_key" ON "PaymentEvent"("provider", "invoiceId")`;

function dockerAvailable() {
  const inspect = spawnSync("docker", ["info"], { encoding: "utf8", shell: true, timeout: 8000 });
  return inspect.status === 0;
}

function dockerRunning(name: string) {
  const inspect = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], {
    encoding: "utf8",
    shell: true,
    timeout: 8000,
  });
  return inspect.status === 0 && inspect.stdout.trim() === "true";
}

function startPrivatePostgres(): { url: string; name: string } | null {
  if (!dockerAvailable()) return null;
  const name = `nv-p0p1-metrika-${process.pid}`;
  const port = 55440 + (process.pid % 50);
  const run = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      name,
      "-e",
      "POSTGRES_PASSWORD=p0p1_test_only",
      "-e",
      "POSTGRES_DB=nv_p0p1_metrika_hist",
      "-p",
      `${port}:5432`,
      "postgres:16",
    ],
    { encoding: "utf8", shell: true, timeout: 120_000 }
  );
  if (run.status !== 0) {
    console.log(run.stderr || run.stdout);
    return null;
  }
  return {
    name,
    url: `postgresql://postgres:p0p1_test_only@127.0.0.1:${port}/nv_p0p1_metrika_hist`,
  };
}

function stopPrivatePostgres(name: string) {
  spawnSync("docker", ["rm", "-f", name], { encoding: "utf8", shell: true, timeout: 30000 });
}

function resolveTarget(): { url: string; dedicatedHistDb: boolean; stop?: () => void } | null {
  if (process.env['TEST_DATABASE_URL']?.trim()) {
    return { url: resolveIsolatedTestDatabaseUrl(), dedicatedHistDb: false };
  }
  if (dockerRunning("nv-p0p1-pg")) return { url: SYNTHETIC_LOCAL_TEST_URL, dedicatedHistDb: false };
  const started = startPrivatePostgres();
  if (!started) return null;
  return {
    url: started.url,
    dedicatedHistDb: true,
    stop: () => stopPrivatePostgres(started.name),
  };
}

async function waitForPostgres(url: string) {
  for (let i = 0; i < 40; i += 1) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      try {
        await client.end();
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("test postgres did not become ready");
}

async function ensureDatabase(adminUrl: string, name: string) {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (found.rowCount === 0) {
    await client.query(`CREATE DATABASE "${name}"`);
  }
  await client.end();
}

function assertHistoricalRow(event: { kind: string; planId: string | null; amountRub: number | null }) {
  if (event.kind !== "purchase" || event.planId !== null || event.amountRub !== null) {
    throw new Error(`historical row was not preserved as nullable analytics: ${JSON.stringify(event)}`);
  }
}

async function runWithClient(histUrl: string) {
  const client = new Client({ connectionString: histUrl });
  await client.connect();
  try {
    await client.query(`DROP TABLE IF EXISTS "PaymentEvent"`);
    await client.query(HIST_TABLE);
    await client.query(HIST_INDEX);
    await client.query(
      `INSERT INTO "PaymentEvent" ("id", "provider", "invoiceId", "userId", "kind") VALUES ($1, $2, $3, $4, $5)`,
      ["hist_event_1", "robokassa", "9001", "user-hist", "purchase"]
    );
    await client.query(readFileSync(migration, "utf8"));
    const row = await client.query(`SELECT "kind", "planId", "amountRub" FROM "PaymentEvent" WHERE "invoiceId" = $1`, [
      "9001",
    ]);
    assertHistoricalRow(row.rows[0] as { kind: string; planId: string | null; amountRub: number | null });
  } finally {
    await client.end();
  }
}

async function runWithPglite() {
  const loaded = await import("@electric-sql/pglite").catch(() => null);
  if (!loaded?.PGlite) return false;
  const db = new loaded.PGlite();
  await db.exec(`DROP TABLE IF EXISTS "PaymentEvent"`);
  await db.exec(HIST_TABLE);
  await db.exec(HIST_INDEX);
  await db.query(
    `INSERT INTO "PaymentEvent" ("id", "provider", "invoiceId", "userId", "kind") VALUES ($1, $2, $3, $4, $5)`,
    ["hist_event_1", "robokassa", "9001", "user-hist", "purchase"]
  );
  await db.exec(readFileSync(migration, "utf8"));
  const row = await db.query(`SELECT "kind", "planId", "amountRub" FROM "PaymentEvent" WHERE "invoiceId" = $1`, [
    "9001",
  ]);
  const event = row.rows[0] as { kind: string; planId: string | null; amountRub: number | null };
  assertHistoricalRow(event);
  await db.close();
  return true;
}

const target = resolveTarget();
if (target) {
  try {
    let histUrl = target.url;
    if (!target.dedicatedHistDb) {
      const adminUrl = target.url.replace(/\/[^/?]+(\?|$)/, "/postgres$1");
      await waitForPostgres(adminUrl);
      await ensureDatabase(adminUrl, "nv_p0p1_metrika_hist");
      histUrl = target.url.replace(/\/[^/?]+(\?|$)/, "/nv_p0p1_metrika_hist$1");
    }
    await waitForPostgres(histUrl);
    await runWithClient(histUrl);
    console.log("historical PaymentEvent survived analytics migration with null planId/amountRub");
    console.log("engine=postgres");
    console.log("PASS");
  } finally {
    target.stop?.();
  }
} else if (await runWithPglite()) {
  console.log("historical PaymentEvent survived analytics migration with null planId/amountRub");
  console.log("engine=pglite");
  console.log("PASS");
} else {
  console.log("SKIP: no isolated TEST_DATABASE_URL, Postgres/Docker, or @electric-sql/pglite.");
  process.exit(2);
}
