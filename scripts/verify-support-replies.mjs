// Private PostgreSQL only; no .env, production database or real mail sender.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', code)(name => name === '@/lib/prisma' ? { prisma: db } : name.startsWith('@/') ? load(`src/${name.slice(2)}.ts`) : require(name), module, module.exports);
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
  for (const sql of readFileSync('prisma/migrations/20261006120000_support_replies/migration.sql', 'utf8').split(';').filter(part => part.trim())) await db.$executeRawUnsafe(sql);
  process.env['ADMIN_SECRET'] = 'synthetic_support_admin';
  process.env['SUPPORT_FROM_EMAIL'] = 'NewVerse Support <support@newvers.ai>';
  const replies = load('src/lib/supportReplies.ts');
  const api = load('src/app/api/admin/support/route.ts');
  const request = (method = 'GET', body, auth = true) => new Request('http://localhost/api/admin/support', { method, headers: { ...(auth ? { authorization: 'Bearer synthetic_support_admin' } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await api.GET(request('GET', null, false))).status, 401);
  assert.equal((await api.POST(request('POST', {}, false))).status, 401);
  const ticket = await db.supportTicket.create({ data: { topic: 'technical', email: 'customer@example.test', message: 'Question' } });
  const payload = { ticketId: ticket.id, clientKey: 'synthetic-reply-key', message: 'Answer', recipient: 'attacker@example.test' };
  const parallel = await Promise.all([api.POST(request('POST', payload)), api.POST(request('POST', payload))]);
  assert.ok(parallel.every(response => response.status === 202));
  assert.equal(await db.supportReply.count(), 1);
  assert.equal((await db.supportReply.findFirst()).recipient, ticket.email);
  assert.equal((await api.POST(request('POST', { ...payload, message: 'Different' }))).status, 409);
  let sends = 0;
  await Promise.all([replies.processSupportReplies(1, async (mail, key) => { sends++; assert.equal(mail.from, process.env['SUPPORT_FROM_EMAIL']); assert.equal(mail.to, ticket.email); assert.ok(key.startsWith('support-reply/')); return 'synthetic_provider_id'; }), replies.processSupportReplies(1, async () => { sends++; return 'synthetic_provider_id'; })]);
  assert.equal(sends, 1);
  assert.equal((await db.supportReply.findFirst()).status, 'accepted');
  assert.equal((await db.supportTicket.findUnique({ where: { id: ticket.id } })).status, 'answered');
  await replies.processSupportReplies(1, async () => { throw new Error('Accepted message replayed'); });
  await replies.enqueueSupportReply(ticket.id, 'synthetic-failure-key', 'Retry answer');
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
  console.log('PASS support replies: migration, access, recipient isolation, concurrent enqueue/claim, replay, retry, expiry, cross-site protection');
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
