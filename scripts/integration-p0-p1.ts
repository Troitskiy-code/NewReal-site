/**
 * Isolated PostgreSQL integration tests for guest claim, transfer, payments, support.
 * Requires TEST_DATABASE_URL whose database name contains p0p1 and is not DATABASE_URL.
 * node --experimental-strip-types scripts/integration-p0-p1.ts
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { PrismaClient } from "@prisma/client";
import { resolveIsolatedTestDatabaseUrl } from "./testDatabaseUrl.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function run(command: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(command, {
    cwd: root,
    env,
    encoding: "utf8",
    shell: true,
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function waitForPostgres(url: string) {
  for (let i = 0; i < 30; i += 1) {
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
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("test postgres did not become ready");
}


async function ensureDatabase(adminUrl: string, name: string) {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (found.rowCount === 0) {
    await client.query(`CREATE DATABASE ${name}`);
  }
  await client.end();
}

function schemaWithoutPgvector(): string {
  const dir = join(tmpdir(), `nv-p0p1-schema-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const source = readFileSync(join(root, "prisma/schema.prisma"), "utf8").replace(
    'Unsupported("vector(1536)")',
    "Bytes"
  );
  const file = join(dir, "schema.prisma");
  writeFileSync(file, source);
  return file;
}

function migrationFiles(): string[] {
  const dir = join(root, "prisma/migrations");
  return readdirSync(dir)
    .filter((name) => /^\d+_/.test(name))
    .sort()
    .map((name) => join(dir, name, "migration.sql"));
}

async function applySqlFiles(url: string, files: string[]) {
  const client = new Client({ connectionString: url });
  await client.connect();
  for (const file of files) {
    await client.query(readFileSync(file, "utf8"));
  }
  await client.end();
}

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("Set an explicitly isolated TEST_DATABASE_URL; automatic shared-port startup is disabled");
}

const testUrl = resolveIsolatedTestDatabaseUrl();
process.env.DATABASE_URL = testUrl;
await waitForPostgres(testUrl);

const parsed = new URL(testUrl.replace(/^postgres(ql)?:/i, "http:"));
const adminUrl = testUrl.replace(/\/[^/?]+(\?|$)/, "/postgres$1");
await ensureDatabase(adminUrl, parsed.pathname.replace(/^\//, ""));

console.log("db push on isolated empty test database");
run("npx prisma generate", { ...process.env, DATABASE_URL: testUrl });
const testSchema = schemaWithoutPgvector();
run(`npx prisma db push --accept-data-loss --skip-generate --schema "${testSchema}"`, {
  ...process.env,
  DATABASE_URL: testUrl,
});

const upgradeName = "nv_p0p1_upgrade";
await ensureDatabase(adminUrl, upgradeName);
const upgradeUrl = testUrl.replace(/\/nv_p0p1_test\b/, `/${upgradeName}`);
const files = migrationFiles();
const rework = files.filter((file) => file.includes("20261001180000"));
console.log("upgrade path: current schema minus rework columns, then 20261001180000");
try {
  run(`npx prisma db push --accept-data-loss --skip-generate --schema "${testSchema}"`, {
    ...process.env,
    DATABASE_URL: upgradeUrl,
  });
  const upgradeClient = new Client({ connectionString: upgradeUrl });
  await upgradeClient.connect();
  await upgradeClient.query(`DROP TABLE IF EXISTS "PaymentEvent"`);
  await upgradeClient.query(`DROP INDEX IF EXISTS "AnonymousChatRequest_status_leaseUntil_idx"`);
  await upgradeClient.query(`DROP INDEX IF EXISTS "SupportTicket_clientKey_key"`);
  await upgradeClient.query(`DROP INDEX IF EXISTS "SupportTicket_delivery_next_idx"`);
  await upgradeClient.query(`ALTER TABLE "AnonymousChatRequest" DROP COLUMN IF EXISTS "payloadHash"`);
  await upgradeClient.query(`ALTER TABLE "AnonymousChatRequest" DROP COLUMN IF EXISTS "attempt"`);
  await upgradeClient.query(`ALTER TABLE "AnonymousChatRequest" DROP COLUMN IF EXISTS "leaseUntil"`);
  await upgradeClient.query(`ALTER TABLE "AnonymousChatRequest" DROP COLUMN IF EXISTS "reservedQuota"`);
  await upgradeClient.query(`ALTER TABLE "AnonymousChatRequest" DROP COLUMN IF EXISTS "refundedAt"`);
  await upgradeClient.query(`ALTER TABLE "SupportTicket" DROP COLUMN IF EXISTS "clientKey"`);
  await upgradeClient.query(`ALTER TABLE "SupportTicket" DROP COLUMN IF EXISTS "payloadHash"`);
  await upgradeClient.query(`ALTER TABLE "SupportTicket" DROP COLUMN IF EXISTS "deliveryStatus"`);
  await upgradeClient.query(`ALTER TABLE "SupportTicket" DROP COLUMN IF EXISTS "deliveryAttempts"`);
  await upgradeClient.query(`ALTER TABLE "SupportTicket" DROP COLUMN IF EXISTS "nextAttemptAt"`);
  await upgradeClient.query(`ALTER TABLE "SupportTicket" DROP COLUMN IF EXISTS "claimedAt"`);
  await upgradeClient.query(`ALTER TABLE "SupportTicket" DROP COLUMN IF EXISTS "claimToken"`);
  await upgradeClient.query(`ALTER TABLE "SupportTicket" DROP COLUMN IF EXISTS "lastError"`);
  await upgradeClient.query(
    `INSERT INTO "AnonymousSession" ("id","sessionId","messagesCount","createdAt","updatedAt")
     VALUES ($1,$2,1,NOW(),NOW())
     ON CONFLICT DO NOTHING`,
    ["upg-sess", "sess-upg"]
  );
  await upgradeClient.query(
    `INSERT INTO "AnonymousChatRequest" ("id","requestId","sessionId","characterId","status","userContent","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'completed','hello',NOW(),NOW())
     ON CONFLICT DO NOTHING`,
    ["upg1", "req-upg", "sess-upg", "char-upg"]
  );
  await upgradeClient.query(
    `INSERT INTO "User" ("id", "email") VALUES ('upg-user', 'upgrade@example.test')
     ON CONFLICT DO NOTHING`
  );
  await upgradeClient.query(
    `INSERT INTO "Transaction" ("id","userId","amount","type","description","createdAt")
     VALUES ('tx-upg', 'upg-user', 100, 'purchase', 'Robokassa InvId=4242', NOW())
     ON CONFLICT DO NOTHING`
  );
  await upgradeClient.end();
  await applySqlFiles(upgradeUrl, rework);
  const after = new Client({ connectionString: upgradeUrl });
  await after.connect();
  const cols = await after.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'AnonymousChatRequest' AND column_name = 'payloadHash'`
  );
  const events = await after.query(`SELECT to_regclass('public."PaymentEvent"') AS rel`);
  const historicalEvent = await after.query(`SELECT "userId" FROM "PaymentEvent" WHERE "provider" = 'robokassa' AND "invoiceId" = '4242'`);
  await after.end();
  assert(cols.rowCount === 1, "upgrade adds payloadHash");
  assert(historicalEvent.rows[0]?.userId === 'upg-user', "upgrade backfills a real historical payment");
  assert(Boolean(events.rows[0]?.rel), "upgrade creates PaymentEvent");
} catch (error) {
  console.error("upgrade migration note:", error instanceof Error ? error.message : error);
  assert(false, "upgrade migration completed");
}

const { claimGuestGeneration, failGuestGeneration, finalizeGuestGeneration } = await import(
  "../src/lib/guestRequestStore.ts"
);
const { transferAnonymousChatToUser } = await import("../src/lib/anonymousTransfer.ts");
const { createOrReplaySupportTicket, claimSupportDeliveries, deliverSupportTicket } = await import(
  "../src/lib/supportOutbox.ts"
);
const { estimatePlanRequestsFromModels } = await import("../src/lib/requestEstimate.ts");
const { prisma } = await import("../src/lib/prisma.js");
const { Prisma } = await import("@prisma/client");

const db = prisma as PrismaClient;

async function seedUser(suffix: string) {
  return db.user.create({
    data: {
      email: `p0p1-${suffix}@example.test`,
      name: "P0P1",
      verseCoins: 0,
      permanentCoins: 0,
    },
  });
}

async function seedCharacter(userId: string) {
  return db.character.create({
    data: {
      name: "P0P1 Character",
      isPublic: true,
      userId,
    },
  });
}

console.log("guest claim / retry / transfer");
const owner = await seedUser("owner");
const character = await seedCharacter(owner.id);
const sessionId = `sess_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

const [first, second] = await Promise.all([
  claimGuestGeneration({ sessionId, requestId, characterId: character.id, message: "hello", quotaLimit: 5 }),
  claimGuestGeneration({ sessionId, requestId, characterId: character.id, message: "hello", quotaLimit: 5 }),
]);
const runs = [first, second].filter((item) => item.kind === "run");
const blocked = [first, second].filter((item) => item.kind === "in_progress" || item.kind === "run");
assert(runs.length === 1, "parallel new claims produce one runner");
assert(blocked.length === 2, "second parallel claim is fenced");
const sessionAfterClaim = await db.anonymousSession.findUnique({ where: { sessionId } });
assert(sessionAfterClaim?.messagesCount === 1, "quota reserved once");

const runner = runs[0];
if (runner.kind === "run") {
  await failGuestGeneration({ sessionId, requestId, attempt: runner.attempt });
}
const afterFail = await db.anonymousChatRequest.findUnique({
  where: { sessionId_requestId: { sessionId, requestId } },
});
assert(afterFail?.status === "failed", "provider failure marks failed");
assert(afterFail?.refundedAt != null, "failure refunds once");

const [retryA, retryB] = await Promise.all([
  claimGuestGeneration({ sessionId, requestId, characterId: character.id, message: "hello", quotaLimit: 5 }),
  claimGuestGeneration({ sessionId, requestId, characterId: character.id, message: "hello", quotaLimit: 5 }),
]);
const retryRuns = [retryA, retryB].filter((item) => item.kind === "run" && item.mode === "retry");
assert(retryRuns.length === 1, "only one failed retry runs");
const retry = retryRuns[0];
if (retry.kind === "run") {
  const userRow = await db.anonymousMessage.create({
    data: { sessionId, characterId: character.id, role: "user", content: "hello", requestId },
  });
  const finalized = await finalizeGuestGeneration({
    sessionId,
    requestId,
    attempt: retry.attempt,
    characterId: character.id,
    assistantContent: "hi there",
    userMessageId: userRow.id,
    remainingMessages: 4,
  });
  assert(Boolean(finalized?.assistantMessageId), "finalize writes assistant atomically");
  const stale = await finalizeGuestGeneration({
    sessionId,
    requestId,
    attempt: retry.attempt - 1,
    characterId: character.id,
    assistantContent: "stale",
    userMessageId: userRow.id,
    remainingMessages: 4,
  });
  assert(stale === null, "stale attempt cannot finalize");
}

const beforeReplay = await db.anonymousSession.findUnique({ where: { sessionId } });
const replay = await claimGuestGeneration({
  sessionId,
  requestId,
  characterId: character.id,
  message: "hello",
  quotaLimit: 5,
});
assert(replay.kind === "replay", "completed request replays");
const quotaAfterReplay = await db.anonymousSession.findUnique({ where: { sessionId } });
assert(quotaAfterReplay?.messagesCount === beforeReplay?.messagesCount, "replay does not consume extra quota");

const lastId = `last_${randomUUID().slice(0, 8)}`;
const used = (await db.anonymousSession.findUnique({ where: { sessionId } }))?.messagesCount ?? 0;
for (let i = 0; i < Math.max(0, 4 - used); i += 1) {
  const id = `fill_${i}_${randomUUID().slice(0, 6)}`;
  const claimed = await claimGuestGeneration({
    sessionId,
    requestId: id,
    characterId: character.id,
    message: `fill ${i}`,
    quotaLimit: 5,
  });
  if (claimed.kind === "run") {
    const row = await db.anonymousMessage.create({
      data: { sessionId, characterId: character.id, role: "user", content: `fill ${i}`, requestId: id },
    });
    await finalizeGuestGeneration({
      sessionId,
      requestId: id,
      attempt: claimed.attempt,
      characterId: character.id,
      assistantContent: "ok",
      userMessageId: row.id,
      remainingMessages: 0,
    });
  }
}
const last = await claimGuestGeneration({
  sessionId,
  requestId: lastId,
  characterId: character.id,
  message: "last",
  quotaLimit: 5,
});
assert(last.kind === "run", "fifth message can still be claimed");
if (last.kind === "run") {
  const row = await db.anonymousMessage.create({
    data: { sessionId, characterId: character.id, role: "user", content: "last", requestId: lastId },
  });
  await finalizeGuestGeneration({
    sessionId,
    requestId: lastId,
    attempt: last.attempt,
    characterId: character.id,
    assistantContent: "last reply",
    userMessageId: row.id,
    remainingMessages: 0,
  });
}
const lastReplay = await claimGuestGeneration({
  sessionId,
  requestId: lastId,
  characterId: character.id,
  message: "last",
  quotaLimit: 5,
});
assert(lastReplay.kind === "replay", "last free completed request can replay at quota 0");

const otherUser = await seedUser("other");
const livePending = await claimGuestGeneration({
  sessionId: `${sessionId}x`,
  requestId: `pend_${randomUUID().slice(0, 8)}`,
  characterId: character.id,
  message: "pending",
  quotaLimit: 5,
});
assert(livePending.kind === "run", "separate session can claim");
if (livePending.kind === "run") {
  const inProgress = await transferAnonymousChatToUser({
    sessionId: `${sessionId}x`,
    userId: owner.id,
  });
  assert(inProgress.ok === false && inProgress.code === "in_progress", "transfer waits on live pending");
}

const transferred = await transferAnonymousChatToUser({ sessionId, userId: owner.id });
assert(transferred.ok === true && transferred.copied > 0, "transfer copies completed messages");
const again = await transferAnonymousChatToUser({ sessionId, userId: owner.id });
assert(again.ok === true && again.alreadyTransferred === true && again.copied === 0, "transfer is idempotent");
const foreign = await transferAnonymousChatToUser({ sessionId, userId: otherUser.id });
assert(foreign.ok === false && foreign.code === "foreign_session", "foreign account cannot steal session");
const revoked = await claimGuestGeneration({
  sessionId,
  requestId,
  characterId: character.id,
  message: "hello",
  quotaLimit: 5,
});
assert(revoked.kind === "revoked", "guest access revoked after transfer");
const userMessages = await db.message.count({ where: { userId: owner.id, characterId: character.id } });
assert(userMessages >= 2, "user history contains copied guest messages");

console.log("payment uniqueness");
const payer = await seedUser("payer");
const invoice = `${Date.now()}`;
const grant = async () => {
  try {
    await db.$transaction([
      db.paymentEvent.create({
        data: { provider: "robokassa", invoiceId: invoice, userId: payer.id, kind: "purchase" },
      }),
      db.user.update({ where: { id: payer.id }, data: { permanentCoins: { increment: 100 } } }),
    ]);
    return "ok";
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "dup";
    throw error;
  }
};
const paymentResults = await Promise.all([grant(), grant(), grant()]);
const payerAfter = await db.user.findUnique({ where: { id: payer.id } });
assert(paymentResults.filter((item) => item === "ok").length === 1, "one payment grant wins");
assert(payerAfter?.permanentCoins === 100, "concurrent webhooks credit once");
await db.transaction.create({
  data: { userId: payer.id, amount: 50, type: "purchase", description: "Robokassa InvId=999001" },
});
const { backfillPaymentEventsFromTransactions } = await import("../src/lib/paymentEvent.ts");
const firstBackfill = await backfillPaymentEventsFromTransactions();
const secondBackfill = await backfillPaymentEventsFromTransactions();
assert(firstBackfill.inserted >= 1, "historical invoice backfill inserts");
assert(secondBackfill.inserted === 0, "historical backfill is idempotent");

console.log("catalog estimate");
await db.model.createMany({
  data: [
    { name: `cheap-${randomUUID()}`, displayName: "Cheap", priceVC: 4, isActive: true },
    { name: `dear-${randomUUID()}`, displayName: "Dear", priceVC: 40, isActive: true },
  ],
});
const models = await db.model.findMany({ where: { isActive: true }, select: { id: true, displayName: true, priceVC: true, isActive: true } });
const estimate = estimatePlanRequestsFromModels(2500, models);
assert(estimate.available && estimate.baseCostVC === 4 && estimate.baseModel === 625, "estimate follows test catalog");

console.log("support outbox");
process.env.SUPPORT_INBOX_EMAIL = "inbox@example.test";
const clientKey = `key${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const created = await createOrReplaySupportTicket({
  clientKey,
  topic: "payment",
  email: "user@example.test",
  message: "Need help with a charge now",
  userId: null,
});
const replayed = await createOrReplaySupportTicket({
  clientKey,
  topic: "payment",
  email: "user@example.test",
  message: "Need help with a charge now",
  userId: null,
});
const conflict = await createOrReplaySupportTicket({
  clientKey,
  topic: "technical",
  email: "user@example.test",
  message: "Need help with a charge now",
  userId: null,
});
assert("ticketId" in created && created.replayed === false, "support create stores ticket");
assert("ticketId" in replayed && replayed.replayed === true && replayed.ticketId === created.ticketId, "support replay keeps ticketId");
assert("conflict" in conflict, "different payload with same clientKey conflicts");

const sendFail = async () => {
  throw new Error("resend down");
};
const claimed = await claimSupportDeliveries(10);
assert(claimed.length >= 1, "outbox claims pending ticket");
const [firstClaim, secondClaim] = await Promise.all([claimSupportDeliveries(10), claimSupportDeliveries(10)]);
assert(firstClaim.length + secondClaim.length === 0, "two workers do not double-claim sending ticket");
if (claimed[0]) {
  const retry = await deliverSupportTicket(claimed[0], sendFail as never);
  assert(retry === "retry", "failed Resend leaves ticket for retry");
  const ticket = await db.supportTicket.findUnique({ where: { id: claimed[0].id } });
  assert(ticket?.deliveryStatus === "failed", "delivery failure is durable");
  const sendOk = async () => undefined;
  const againClaim = await claimSupportDeliveries(10, new Date(Date.now() + 60 * 60 * 1000));
  const recovered = againClaim.find((row) => row.id === claimed[0].id);
  assert(Boolean(recovered), "worker retries after failure");
  if (recovered) {
    const sent = await deliverSupportTicket(recovered, sendOk as never);
    assert(sent === "sent", "worker sends after recovery");
  }
}

console.log("runtime role without DDL");
try {
  const appClient = new Client({ connectionString: adminUrl });
  await appClient.connect();
  await appClient.query("DO $$ BEGIN CREATE ROLE nv_p0p1_app LOGIN PASSWORD 'synth_app_only'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;");
  await appClient.query("GRANT CONNECT ON DATABASE nv_p0p1_test TO nv_p0p1_app");
  await appClient.end();
  const grantClient = new Client({ connectionString: testUrl });
  await grantClient.connect();
  await grantClient.query("GRANT USAGE ON SCHEMA public TO nv_p0p1_app");
  await grantClient.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nv_p0p1_app");
  await grantClient.end();
  const appUrl = testUrl.replace(/\/\/([^:@]+):([^@]+)@/, "//nv_p0p1_app:synth_app_only@");
  const app = new Client({ connectionString: appUrl });
  await app.connect();
  const selectOk = await app.query('SELECT 1 FROM "AnonymousChatRequest" LIMIT 1');
  let ddlDenied = false;
  try {
    await app.query("CREATE TABLE p0p1_should_not_exist (id int)");
  } catch {
    ddlDenied = true;
  }
  await app.end();
  assert(selectOk.rowCount !== null, "app role can read guest tables");
  assert(ddlDenied, "app role cannot CREATE TABLE");
} catch (error) {
  console.error("restricted role check skipped:", error instanceof Error ? error.message : error);
  assert(false, "app role without DDL");
}

await db.$disconnect();

console.log("");
if (failed > 0) {
  console.error(`Integration failed ${failed} of ${passed + failed}`);
  process.exit(1);
}
console.log(`Integration passed ${passed} checks`);
