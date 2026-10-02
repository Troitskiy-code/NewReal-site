import { Client } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export async function verifyP1MigrationUpgrade({ databaseUrl, schemaPath, check }) {
  const source = new URL(databaseUrl);
  if (source.hostname !== '127.0.0.1' || source.pathname !== '/nv_guest_p1_test') throw new Error('Upgrade fixture requires private guest-test cluster');
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() }); await admin.connect();
  try { await admin.query('CREATE DATABASE nv_p1_legacy_upgrade_test'); } finally { await admin.end(); }
  const legacyUrl = new URL(source); legacyUrl.pathname = '/nv_p1_legacy_upgrade_test';
  const legacy = new Client({ connectionString: legacyUrl.toString() }); await legacy.connect();
  const migrations = join(dirname(schemaPath), 'migrations');
  const names = readdirSync(migrations).filter(n => /^\d+_/.test(n)).sort();
  try {
    await legacy.query(readFileSync(join(migrations, '20260801000000_baseline/migration.sql'), 'utf8'));
    await legacy.query('DROP TABLE "PaymentEvent", "RateLimitBucket"');
    for (const column of ['payloadHash', 'attempt', 'leaseUntil', 'reservedQuota', 'refundedAt']) await legacy.query(`ALTER TABLE "AnonymousChatRequest" DROP COLUMN "${column}"`);
    for (const column of ['clientKey', 'payloadHash', 'deliveryStatus', 'deliveryAttempts', 'nextAttemptAt', 'claimedAt', 'claimToken', 'lastError']) await legacy.query(`ALTER TABLE "SupportTicket" DROP COLUMN "${column}"`);
    await legacy.query(`CREATE TABLE "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY, "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ, "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`);
    for (const name of names.filter(n => n !== '20260801000000_baseline' && n <= '20261001120000_guest_chat_and_support')) {
      const text = readFileSync(join(migrations, name, 'migration.sql'), 'utf8');
      await legacy.query(text);
      await legacy.query('INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, applied_steps_count) VALUES ($1,$2,$3,now(),1)', [randomUUID(), createHash('sha256').update(text).digest('hex'), name]);
    }
    await legacy.query(`INSERT INTO "User" (id,email) VALUES ('legacy-owner','upgrade@example.test')`);
    await legacy.query(`INSERT INTO "Transaction" (id,"userId",amount,type,description) VALUES ('legacy-tx','legacy-owner',100,'purchase','Robokassa InvId=777')`);
    await legacy.query(`INSERT INTO "AnonymousSession" (id,"sessionId","messagesCount","updatedAt") VALUES ('legacy-session','migration-guest',1,now())`);
    await legacy.query(`INSERT INTO "AnonymousChatRequest" (id,"requestId","sessionId","characterId",status,"userContent","updatedAt") VALUES ('legacy-request','migration-pending','migration-guest','character-old','pending','old prompt',now())`);
    await legacy.query(`INSERT INTO "SupportTicket" (id,topic,email,message) VALUES ('legacy-ticket','technical','upgrade@example.test','Old delivered ticket')`);
  } finally { await legacy.end(); }
  function run(args, env = {}) {
    const result = spawnSync(process.execPath, args, { env: { ...process.env, DATABASE_URL: legacyUrl.toString(),
      MIGRATION_DATABASE_URL: legacyUrl.toString(), ...env }, encoding: 'utf8', timeout: 60000, windowsHide: true });
    if (result.status !== 0) throw new Error(`Private upgrade command failed: ${result.stdout}\n${result.stderr}`);
    return result;
  }
  run(['scripts/migration-preflight.mjs']);
  check(true, 'baseline preflight accepts a populated pre-P1 schema');
  run(['node_modules/prisma/build/index.js', 'migrate', 'resolve', '--applied', '20260801000000_baseline', '--schema', schemaPath]);
  run(['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', schemaPath]);
  check(true, 'existing database resolves baseline and deploys remaining migrations through Prisma CLI');
  run(['scripts/migration-preflight.mjs', '--ready']);
  check(true, 'post-upgrade preflight accepts the complete existing database');
  const inspect = new Client({ connectionString: legacyUrl.toString() }); await inspect.connect();
  try {
    const payment = await inspect.query(`SELECT "userId" FROM "PaymentEvent" WHERE "invoiceId"='777'`);
    const guest = await inspect.query(`SELECT "payloadHash",status,"reservedQuota" FROM "AnonymousChatRequest" WHERE id='legacy-request'`);
    const ticket = await inspect.query(`SELECT "deliveryStatus" FROM "SupportTicket" WHERE id='legacy-ticket'`);
    check(payment.rows[0]?.userId === 'legacy-owner' && guest.rows[0]?.status === 'failed'
      && guest.rows[0]?.reservedQuota && guest.rows[0]?.payloadHash.length === 64
      && ticket.rows[0]?.deliveryStatus === 'manual_review', 'CLI upgrade preserves data and applies payment/guest/support backfills');
  } finally { await inspect.end(); }
}
