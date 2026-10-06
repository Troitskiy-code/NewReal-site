// Private PostgreSQL only; no .env, production database or real mail sender.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { PrismaClient } from '@prisma/client';
const require = createRequire(import.meta.url);
const runtime = process.env['GUEST_TEST_RUNTIME'] || join(tmpdir(), 'nv-p1-isolated-runtime');
const EmbeddedPostgres = require(join(runtime, 'node_modules/embedded-postgres/dist/index.js')).default;
const port = await new Promise(done => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => done(p)); }); });
const directory = mkdtempSync(join(tmpdir(), 'nv-support-'));
const pg = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), user: 'postgres', password: 'synthetic_support', port, persistent: true, onLog() {} });
const url = `postgresql://postgres:synthetic_support@127.0.0.1:${port}/support_test`;
const db = new PrismaClient({ datasourceUrl: url, log: [] });
const cache = new Map();
function load(file) {
  file = resolve(file);
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (name === '@/lib/prisma') return { prisma: db };
    if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
    if (name.startsWith('.')) {
      const target = resolve(dirname(file), name);
      return load(existsSync(target + '.ts') ? target + '.ts' : target + '.js');
    }
    return require(name);
  }, module, module.exports);
  cache.set(file, module.exports); return module.exports;
}
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('support_test');
  const schema = join(directory, 'schema.prisma');
  // Begin with historical schema; apply the actual production SQL afterwards.
  const source = readFileSync('prisma/schema.prisma', 'utf8').replace('Unsupported("vector(1536)")', 'Bytes')
    .replace('  replies           SupportReply[]', '').replace(/\nmodel SupportReply \{[\s\S]*?\n\}/, '');
  writeFileSync(schema, source);
  const setup = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', schema], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr);
  process.env['ADMIN_SECRET'] = 'synthetic_support_admin';
  process.env['SUPPORT_FROM_EMAIL'] = 'NewVerse Support <support@newvers.ai>';
  const replies = load('src/lib/supportReplies.ts');
  const api = load('src/app/api/admin/support/route.ts');
  const migrationApi = load('src/app/api/admin/support/migration/route.ts');
  const migration = load('src/lib/supportMigration.ts');
  const admin = load('src/lib/supportAdmin.ts');
  const originEnv = Object.fromEntries(['NODE_ENV', 'NEXTAUTH_URL', 'NEXT_PUBLIC_APP_URL'].map(key => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = 'production'; process.env.NEXTAUTH_URL = ''; process.env.NEXT_PUBLIC_APP_URL = '';
    const originCheck = (url, origin, extra = {}) => admin.supportAdminOriginAllowed(new Request(url, { headers: { origin, ...extra } }));
    assert.equal(originCheck('http://app-internal:3000/api/admin/support', 'https://newvers.ai'), true, 'external HTTPS allowed behind internal HTTP proxy');
    for (const origin of ['https://evil.example', 'https://newvers.ai.evil.example', 'null', 'https://newvers.ai@evil.example', 'https://newvers.ai/path'])
      assert.equal(originCheck('http://app-internal:3000/api/admin/support', origin), false);
    assert.equal(originCheck('https://evil.example/api/admin/support', 'https://evil.example', { 'x-forwarded-host': 'newvers.ai', 'x-forwarded-proto': 'https' }), false, 'Host/forwarded headers cannot whitelist attacker');
    assert.equal(originCheck('http://localhost:3000/api/admin/support', 'http://localhost:3000'), false, 'production requires configured local origin');
    process.env.NEXTAUTH_URL = 'https://preview.example.test/api/auth';
    assert.equal(originCheck('http://app-internal:3000/api/admin/support', 'https://preview.example.test'), true, 'server-configured public origin allowed');
    process.env.NEXTAUTH_URL = ''; process.env.NEXT_PUBLIC_APP_URL = 'https://other-preview.example.test';
    assert.equal(originCheck('http://app-internal:3000/api/admin/support', 'https://other-preview.example.test'), true);
    process.env.NEXT_PUBLIC_APP_URL = 'placeholder_not_a_url';
    assert.equal(originCheck('https://evil.example/api/admin/support', 'https://evil.example'), false);
    process.env.NODE_ENV = 'development';
    assert.equal(originCheck('http://localhost:3000/api/admin/support', 'http://localhost:3000'), true, 'local development supported');
  } finally {
    for (const [key, value] of Object.entries(originEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const migrationName = '20261006120000_support_replies';
  const migrationPayload = { action: 'apply', migration: migrationName };
  const request = (method = 'GET', body, auth = true, query = '') => new Request('http://localhost/api/admin/support' + query, { method, headers: { ...(auth ? { authorization: 'Bearer synthetic_support_admin' } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const migrationRequest = (method = 'GET', body, auth = true) => new Request('http://localhost/api/admin/support/migration', {
    method, headers: { ...(auth ? { authorization: 'Bearer synthetic_support_admin' } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const proxyRequest = (path, body) => new Request('http://app-internal:3000' + path, { method: 'POST',
    headers: { authorization: 'Bearer synthetic_support_admin', 'content-type': 'application/json', origin: 'https://newvers.ai' }, body: JSON.stringify(body) });
  assert.equal((await migrationApi.POST(proxyRequest('/api/admin/support/migration', { action: 'apply', migration: 'other' }))).status, 400, 'proxy origin accepted before payload validation');
  assert.equal((await migrationApi.GET(migrationRequest('GET', null, false))).status, 401);
  assert.equal((await migrationApi.POST(migrationRequest('POST', migrationPayload, false))).status, 401);
  assert.equal((await migrationApi.POST(migrationRequest('POST', { action: 'apply', migration: 'other' }))).status, 400);
  assert.equal((await migrationApi.POST(migrationRequest('POST', { ...migrationPayload, sql: 'DROP TABLE "SupportTicket"' }))).status, 400);
  const crossMigration = migrationRequest('POST', migrationPayload); crossMigration.headers.set('origin', 'https://evil.example');
  const deniedMigration = await migrationApi.POST(crossMigration);
  assert.equal(deniedMigration.status, 403); assert.equal((await deniedMigration.json()).code, 'SUPPORT_ORIGIN_DENIED');
  let inspection = await (await migrationApi.GET(migrationRequest())).json();
  assert.equal(inspection.history, 'missing'); assert.equal(inspection.canApply, true); assert.equal(inspection.mode, 'schema_only');
  assert.equal((await db.$queryRaw`SELECT to_regclass('"SupportReply"') IS NULL AS missing`)[0].missing, true, 'schema-only inspection is read-only');
  assert.equal((await api.GET(request('GET', null, false))).status, 401);
  assert.equal((await api.POST(request('POST', {}, false))).status, 401);
  const ticket = await db.supportTicket.create({ data: { topic: 'technical', email: 'customer@example.test', message: 'Question' } });
  const payload = { ticketId: ticket.id, clientKey: 'synthetic-reply-key', message: 'Answer', recipient: 'attacker@example.test' };
  const detailRequest = () => request('GET', null, true, '?ticketId=' + ticket.id);
  assert.equal((await api.GET(request())).status, 200, 'historical schema still lists tickets');
  let detail = await api.GET(detailRequest());
  assert.equal(detail.status, 200, 'missing reply table does not hide ticket');
  let body = await detail.json();
  assert.equal(body.ticket.message, ticket.message);
  assert.equal(body.replyAvailability.code, 'SUPPORT_SCHEMA_NOT_READY');
  assert.equal(body.replyAvailability.ready, false);
  assert.ok(body.replyAvailability.message.includes('20261006120000_support_replies'));
  const missingSchemaPost = await api.POST(request('POST', payload));
  assert.equal(missingSchemaPost.status, 503);
  assert.equal((await missingSchemaPost.json()).code, 'SUPPORT_SCHEMA_NOT_READY');
  // Reproduce the deployed site's case: populated SupportTicket, no Prisma history.
  await db.$executeRawUnsafe('CREATE INDEX "SupportReply_status_nextAttemptAt_idx" ON "SupportTicket" (status)');
  assert.equal((await migrationApi.POST(migrationRequest('POST', migrationPayload))).status, 503);
  assert.equal((await db.$queryRaw`SELECT to_regclass('"SupportReply"') IS NULL AS missing`)[0].missing, true, 'schema-only failed installation rolled back');
  await db.$executeRawUnsafe('DROP INDEX "SupportReply_status_nextAttemptAt_idx"');
  const installed = await Promise.all([migrationApi.POST(proxyRequest('/api/admin/support/migration', migrationPayload)), migrationApi.POST(migrationRequest('POST', migrationPayload))]);
  assert.ok(installed.some(response => response.status === 200));
  assert.ok(installed.every(response => [200, 409].includes(response.status)));
  inspection = await (await migrationApi.GET(migrationRequest())).json();
  assert.equal(inspection.ready, true); assert.equal(inspection.canApply, false); assert.equal(inspection.mode, 'schema_only');
  assert.equal(inspection.history, 'missing');
  assert.equal((await db.$queryRaw`SELECT to_regclass('"_prisma_migrations"') IS NULL AS missing`)[0].missing, true, 'installation never fabricates Prisma history');
  assert.equal((await db.supportTicket.findUnique({ where: { id: ticket.id } })).message, ticket.message, 'existing ticket preserved');
  const noHistoryReply = await api.POST(proxyRequest('/api/admin/support', { ...payload, clientKey: 'synthetic_no_history_reply' }));
  assert.equal(noHistoryReply.status, 202, 'reply can be queued without Prisma history');
  // Explicitly due: PostgreSQL timestamp(3) can round 1ms ahead of JS Date.
  await db.supportReply.updateMany({ where: { status: 'pending' }, data: { nextAttemptAt: new Date(0) } });
  await replies.processSupportReplies(1, async mail => { assert.equal(mail.to, ticket.email); return 'synthetic_no_history_provider'; });
  const savedWithoutHistory = await db.supportReply.findUnique({ where: { clientKey: 'synthetic_no_history_reply' } });
  assert.equal(savedWithoutHistory.status, 'accepted', 'reply can be sent without Prisma history');
  assert.equal((await (await migrationApi.POST(migrationRequest('POST', migrationPayload))).json()).appliedNow, false);
  assert.equal((await db.supportReply.findUnique({ where: { id: savedWithoutHistory.id } })).message, payload.message, 'repeated install preserves replies');
  // Reset this private fixture to test the conventional Prisma-history mode too.
  await db.$executeRawUnsafe('DROP TABLE "SupportReply"');
  await db.$executeRawUnsafe(`CREATE TABLE "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY, "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ, "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`);
  assert.equal((await migrationApi.POST(migrationRequest('POST', migrationPayload))).status, 409, 'uninitialized baseline history blocks writes');
  for (const name of readdirSync('prisma/migrations').filter(name => /^\d+_/.test(name))) {
    const text = readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');
    const target = join(directory, 'migrations', name); mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'migration.sql'), text);
    if (name !== migrationName) await db.$executeRaw`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, applied_steps_count)
      VALUES (${randomUUID()}, ${createHash('sha256').update(text).digest('hex')}, ${name}, now(), 1)`;
  }
  writeFileSync(join(directory, 'migrations/migration_lock.toml'), 'provider = "postgresql"\n');
  inspection = await (await migrationApi.GET(migrationRequest())).json();
  assert.equal(inspection.ready, false); assert.equal(inspection.canApply, true);
  assert.equal((await db.$queryRaw`SELECT to_regclass('"SupportReply"') IS NULL AS missing`)[0].missing, true, 'GET never creates table');
  await db.$executeRawUnsafe('CREATE ROLE support_migration_reader LOGIN PASSWORD \'synthetic_test_reader\'');
  await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO support_migration_reader');
  await db.$executeRawUnsafe('GRANT SELECT ON ALL TABLES IN SCHEMA public TO support_migration_reader');
  const readerUrl = new URL(url); readerUrl.username = 'support_migration_reader'; readerUrl.password = 'synthetic_test_reader';
  const reader = new PrismaClient({ datasourceUrl: readerUrl.toString(), log: [] });
  try {
    const limited = await migration.inspectSupportMigration(reader);
    assert.equal(limited.canApply, false); assert.ok(limited.message.includes('прав'));
  } finally { await reader.$disconnect(); }
  await db.$executeRaw`INSERT INTO "_prisma_migrations" (id, checksum, migration_name) VALUES ('synthetic_failed', 'synthetic', 'synthetic_failed')`;
  assert.equal((await migrationApi.POST(migrationRequest('POST', migrationPayload))).status, 409, 'unfinished migration blocks writes');
  await db.$executeRaw`DELETE FROM "_prisma_migrations" WHERE id = 'synthetic_failed'`;
  await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(20261006, 120000)`;
    assert.equal((await migrationApi.POST(migrationRequest('POST', migrationPayload))).status, 409, 'concurrent migration locked');
  });
  // Conflict on the final index forces a real DDL rollback after table creation.
  await db.$executeRawUnsafe('CREATE INDEX "SupportReply_status_nextAttemptAt_idx" ON "SupportTicket" (status)');
  assert.equal((await migrationApi.POST(migrationRequest('POST', migrationPayload))).status, 503);
  assert.equal((await db.$queryRaw`SELECT to_regclass('"SupportReply"') IS NULL AS missing`)[0].missing, true, 'failed DDL rolled back');
  assert.equal((await db.$queryRaw`SELECT count(*)::integer AS count FROM "_prisma_migrations" WHERE migration_name = ${migrationName}`)[0].count, 0);
  await db.$executeRawUnsafe('DROP INDEX "SupportReply_status_nextAttemptAt_idx"');
  const applied = await Promise.all([migrationApi.POST(migrationRequest('POST', migrationPayload)), migrationApi.POST(migrationRequest('POST', migrationPayload))]);
  assert.ok(applied.some(response => response.status === 200));
  assert.ok(applied.every(response => [200, 409].includes(response.status)));
  inspection = await (await migrationApi.GET(migrationRequest())).json();
  assert.equal(inspection.ready, true); assert.equal(inspection.history, 'applied');
  const history = await db.$queryRaw`SELECT checksum FROM "_prisma_migrations" WHERE migration_name = ${migrationName}`;
  assert.equal(history.length, 1);
  assert.equal(history[0].checksum, createHash('sha256').update(readFileSync(`prisma/migrations/${migrationName}/migration.sql`, 'utf8')).digest('hex'));
  assert.equal((await (await migrationApi.POST(migrationRequest('POST', migrationPayload))).json()).appliedNow, false);
  await db.$executeRaw`INSERT INTO "_prisma_migrations" (id, checksum, migration_name) VALUES ('synthetic_failed_after', 'synthetic', 'synthetic_failed_after')`;
  assert.equal((await migrationApi.POST(migrationRequest('POST', migrationPayload))).status, 409, 'unfinished history is not bypassed by ready schema');
  await db.$executeRaw`DELETE FROM "_prisma_migrations" WHERE id = 'synthetic_failed_after'`;
  const preserved = await db.supportReply.create({ data: { ticketId: ticket.id, clientKey: 'synthetic_preserved_reply', payloadHash: 'synthetic',
    recipient: ticket.email, sender: 'support@newvers.ai', message: 'Existing answer', status: 'accepted' } });
  await db.$executeRaw`DELETE FROM "_prisma_migrations" WHERE migration_name = ${migrationName}`;
  inspection = await (await migrationApi.GET(migrationRequest())).json();
  assert.equal(inspection.ready, true); assert.equal(inspection.canApply, true); assert.equal(inspection.state, 'untracked');
  assert.equal((await migrationApi.POST(migrationRequest('POST', migrationPayload))).status, 200, 'existing compatible table only records history');
  assert.equal((await db.supportReply.findUnique({ where: { id: preserved.id } })).message, 'Existing answer');
  await db.supportReply.delete({ where: { id: preserved.id } });
  const futureDeploy = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', schema], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 60000 });
  assert.equal(futureDeploy.status, 0, futureDeploy.stderr); assert.ok(futureDeploy.stdout.includes('No pending migrations'));
  // A partially deployed schema must show the same actionable notice (P2022).
  await db.$executeRawUnsafe('ALTER TABLE "SupportReply" DROP COLUMN "message"');
  assert.equal((await migrationApi.POST(migrationRequest('POST', migrationPayload))).status, 409, 'partial table not auto-repaired');
  body = await (await api.GET(detailRequest())).json();
  assert.equal(body.ticket.message, ticket.message);
  assert.equal(body.replyAvailability.code, 'SUPPORT_SCHEMA_NOT_READY');
  await db.$executeRawUnsafe('ALTER TABLE "SupportReply" ADD COLUMN "message" TEXT NOT NULL');
  body = await (await api.GET(detailRequest())).json();
  assert.equal(body.replyAvailability.ready, true, 'migration restores replies without changing ticket');
  const parallel = await Promise.all([api.POST(request('POST', payload)), api.POST(request('POST', payload))]);
  assert.ok(parallel.every(response => response.status === 202));
  assert.equal(await db.supportReply.count(), 1);
  assert.equal((await db.supportReply.findFirst()).recipient, ticket.email);
  assert.equal((await api.POST(request('POST', { ...payload, message: 'Different' }))).status, 409);
  await db.supportReply.updateMany({ where: { status: 'pending' }, data: { nextAttemptAt: new Date(0) } });
  let sends = 0;
  await Promise.all([replies.processSupportReplies(1, async (mail, key) => { sends++; assert.equal(mail.from, process.env['SUPPORT_FROM_EMAIL']); assert.equal(mail.to, ticket.email); assert.ok(key.startsWith('support-reply/')); return 'synthetic_provider_id'; }), replies.processSupportReplies(1, async () => { sends++; return 'synthetic_provider_id'; })]);
  assert.equal(sends, 1);
  assert.equal((await db.supportReply.findFirst()).status, 'accepted');
  assert.equal((await db.supportTicket.findUnique({ where: { id: ticket.id } })).status, 'answered');
  await replies.processSupportReplies(1, async () => { throw new Error('Accepted message replayed'); });
  await replies.enqueueSupportReply(ticket.id, 'synthetic-failure-key', 'Retry answer');
  await db.supportReply.update({ where: { clientKey: 'synthetic-failure-key' }, data: { nextAttemptAt: new Date(0) } });
  await replies.processSupportReplies(1, async () => { throw new Error('secret that must never be logged'); });
  let failed = await db.supportReply.findUnique({ where: { clientKey: 'synthetic-failure-key' } });
  assert.equal(failed.status, 'failed');
  await db.supportReply.update({ where: { id: failed.id }, data: { nextAttemptAt: new Date(0) } });
  await replies.processSupportReplies(1, async () => 'synthetic_retry_id');
  failed = await db.supportReply.findUnique({ where: { id: failed.id } });
  assert.equal(failed.status, 'accepted'); assert.equal(failed.attempts, 2);
  await replies.enqueueSupportReply(ticket.id, 'synthetic-expired-key', 'Expired');
  await db.supportReply.update({ where: { clientKey: 'synthetic-expired-key' }, data: { createdAt: new Date(0) } });
  await replies.processSupportReplies(1, async () => { throw new Error('Expired message sent'); });
  assert.equal((await db.supportReply.findUnique({ where: { clientKey: 'synthetic-expired-key' } })).status, 'dead');
  const crossSite = request('POST', { ...payload, clientKey: 'synthetic-other-key' }); crossSite.headers.set('origin', 'https://evil.example');
  assert.equal((await api.POST(crossSite)).status, 403);
  console.log('PASS support replies: trusted proxy origins, Host spoof rejected, installation/reply through internal HTTP, schema-only and Prisma modes, rollback, auth/locks, checksum/deploy compatibility, reply retry');
} finally {
  await db.$disconnect();
  // Graceful pg_ctl avoids Windows taskkill leaving PostgreSQL I/O workers alive.
  if (process.platform === 'win32') {
    const ctl = join(runtime, 'node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe');
    const stopped = spawnSync(ctl, ['stop', '-D', join(directory, 'db'), '-m', 'fast', '-w'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(stopped.status, 0, 'private cluster stopped');
  } else await pg.stop();
  pg.process = undefined;
}
