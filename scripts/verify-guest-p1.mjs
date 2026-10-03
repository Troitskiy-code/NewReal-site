// Uses a private, disposable PostgreSQL cluster. Never reads .env or DATABASE_URL.
// Runtime: npm install --prefix <temporary-directory> embedded-postgres
// Run: GUEST_TEST_RUNTIME=<temporary-directory> node scripts/verify-guest-p1.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { PrismaClient } from '@prisma/client';

const require = createRequire(import.meta.url);
const runtime = process.env['GUEST_TEST_RUNTIME'];
if (!runtime) throw new Error('GUEST_TEST_RUNTIME must name an isolated embedded-postgres installation');
const EmbeddedPostgres = require(join(resolve(runtime), 'node_modules/embedded-postgres/dist/index.js')).default;
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)); });
});
const directory = mkdtempSync(join(tmpdir(), 'nv-guest-p1-'));
const pg = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), user: 'postgres',
  password: 'synthetic_guest_test', port, persistent: true, initdbFlags: ['--encoding=UTF8'], onLog() {} });
const url = `postgresql://postgres:synthetic_guest_test@127.0.0.1:${port}/nv_guest_p1_test`;
const db = new PrismaClient({ datasourceUrl: url, log: [] });
const cache = new Map();
function load(file, mocks = {}) {
  file = resolve(file);
  if (cache.has(file)) return cache.get(file);
  const loaded = { exports: {} }; cache.set(file, loaded.exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  const dependency = (name) => {
    if (name === '@/lib/prisma') return { prisma: db };
    if (name in mocks) return mocks[name];
    if (name.startsWith('@/')) return load(join('src', name.slice(2) + '.ts'), mocks);
    if (name.startsWith('.')) {
      const target = resolve(dirname(file), name);
      if (target === resolve('src/lib/prisma') || target === resolve('src/lib/prisma.js')) return { prisma: db };
      if (target.endsWith('.json')) return require(target);
      return load(existsSync(target + '.ts') ? target + '.ts' : target + '.js', mocks);
    }
    return require(name);
  };
  new Function('require', 'module', 'exports', code)(dependency, loaded, loaded.exports);
  cache.set(file, loaded.exports); return loaded.exports;
}
let checks = 0;
let browserDatabaseUrl = url;
function check(value, label) { assert.ok(value, label); checks++; console.log(`PASS ${label}`); }
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('nv_guest_p1_test');
  const schema = join(directory, 'schema.prisma');
  writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace('Unsupported("vector(1536)")', 'Bytes'));
  if (process.env['P1_CLOSURE'] === '1') {
    for (const name of readdirSync('prisma/migrations').filter(name => /^\d+_/.test(name))) {
      const target = join(directory, 'migrations', name); mkdirSync(target, { recursive: true });
      // pgvector/RAG is separately scoped P2. Keep all P1 SQL intact on native PG.
      const sql = readFileSync(join('prisma/migrations', name, 'migration.sql'), 'utf8')
        .replace('CREATE EXTENSION IF NOT EXISTS vector;', '-- pgvector omitted only in this disposable test')
        .replace(/vector\(1536\)/g, 'BYTEA');
      writeFileSync(join(target, 'migration.sql'), sql);
    }
    writeFileSync(join(directory, 'migrations/migration_lock.toml'), 'provider = "postgresql"\n');
  }
  const arguments_ = process.env['P1_CLOSURE'] === '1' ? ['migrate', 'deploy', '--schema', schema]
    : ['db', 'push', '--skip-generate', '--schema', schema];
  const push = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...arguments_],
    { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 90000 });
  if (push.status !== 0) throw new Error(`Isolated schema setup failed: ${push.stdout}\n${push.stderr}`);
  if (process.env['P1_CLOSURE'] === '1') {
    const { verifyP1Closure } = await import('./verify-p1-closure.mjs');
    const closure = await verifyP1Closure({ db, load, check, cache, databaseUrl: url, schemaPath: schema });
    browserDatabaseUrl = closure.limitedDatabaseUrl;
  }
  const store = load('src/lib/guestRequestStore.ts');
  const transfer = load('src/lib/anonymousTransfer.ts');
  const retry = load('src/lib/guestTransferRetry.ts');
  const callback = load('src/lib/safeCallbackUrl.ts');
  check(callback.sanitizeCallbackUrl('/ru/chat/test') === '/ru/chat/test', 'localized callback preserves chat return');
  check(callback.sanitizeCallbackUrl('/en/login') === '/', 'localized auth callback remains rejected');
  const user = await db.user.create({ data: { email: 'guest-test@example.test' } });
  const character = await db.character.create({ data: { name: 'Test', description: 'Test', userId: user.id, isPublic: true } });
  const input = { sessionId: 'guest-concurrent', requestId: 'request-concurrent', characterId: character.id,
    message: 'hello', quotaLimit: 5 };
  const quota = async (sessionId = input.sessionId) => (await db.anonymousSession.findUniqueOrThrow({ where: { sessionId } })).messagesCount;
  const first = await Promise.all([store.claimGuestGeneration(input), store.claimGuestGeneration(input)]);
  check(first.filter(r => r.kind === 'run').length === 1 && await quota() === 1, 'parallel first claim reserves once');
  await Promise.all([store.failGuestGeneration({ ...input, attempt: 1 }), store.failGuestGeneration({ ...input, attempt: 1 })]);
  check(await quota() === 0, 'concurrent failure refunds once');
  const claims = await Promise.all(Array.from({ length: 8 }, () => store.claimGuestGeneration(input)));
  check(claims.filter(r => r.kind === 'run').length === 1 && await quota() === 1, 'eight concurrent retries reserve once');
  await store.failGuestGeneration({ ...input, attempt: 1 });
  check(await quota() === 1, 'stale failure cannot refund attempt two');
  const generation = { ...input, attempt: 2 };
  const messages = await Promise.all([store.persistGuestUserMessage(generation), store.persistGuestUserMessage(generation)]);
  check(messages[0].id === messages[1].id && await db.anonymousMessage.count() === 1, 'parallel persistence creates one user message');
  check(await store.persistGuestUserMessage({ ...generation, attempt: 1 }) === null, 'stale persistence creates nothing');
  const waiting = await transfer.transferAnonymousChatToUser({ sessionId: input.sessionId, userId: user.id });
  check(!waiting.ok && waiting.code === 'in_progress', 'transfer waits for live generation');
  check(await store.renewGuestGeneration(generation), 'current attempt renews lease');
  check(!await store.renewGuestGeneration({ ...generation, attempt: 1 }), 'old attempt cannot renew lease');
  const end = await store.finalizeGuestGeneration({ ...generation, assistantContent: 'reply', userMessageId: messages[0].id, remainingMessages: 4 });
  check(Boolean(end), 'current attempt finalizes');
  const transfers = await Promise.all([1, 2].map(() => transfer.transferAnonymousChatToUser({ sessionId: input.sessionId, userId: user.id })));
  check(transfers.every(r => r.ok) && transfers.reduce((sum, r) => sum + r.copied, 0) === 2, 'parallel transfer copies pair once');
  check(await db.message.count({ where: { userId: user.id } }) === 2, 'account history contains exactly two messages');
  check((await store.claimGuestGeneration(input)).kind === 'revoked', 'transferred session cannot generate again');
  const stale = { ...input, sessionId: 'guest-stale', requestId: 'request-stale' };
  await store.claimGuestGeneration(stale);
  await db.anonymousChatRequest.updateMany({ where: { sessionId: stale.sessionId }, data: { leaseUntil: new Date(0) } });
  check(!await store.renewGuestGeneration({ ...stale, attempt: 1 }), 'expired lease cannot be resurrected');
  await Promise.all([store.recoverGuestSession(stale.sessionId), store.recoverGuestSession(stale.sessionId)]);
  check(await quota(stale.sessionId) === 0, 'expired recovery refunds once');
  check((await store.claimGuestGeneration(stale)).attempt === 2 && await quota(stale.sessionId) === 1, 'recovered generation can retry');
  // Force the request-link write to fail inside the real transaction.
  const atomic = { ...input, sessionId: 'guest-atomic', requestId: 'request-atomic' };
  await store.claimGuestGeneration(atomic);
  await db.$executeRawUnsafe(`CREATE FUNCTION fail_guest_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."sessionId" = 'guest-atomic' AND NEW."userMessageId" IS NOT NULL THEN RAISE EXCEPTION 'synthetic link failure'; END IF;
    RETURN NEW; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER fail_guest_link BEFORE UPDATE ON "AnonymousChatRequest" FOR EACH ROW EXECUTE FUNCTION fail_guest_link()`);
  await assert.rejects(() => store.persistGuestUserMessage({ ...atomic, attempt: 1 }));
  check(await db.anonymousMessage.count({ where: { sessionId: atomic.sessionId } }) === 0, 'failed request-link write rolls back user message');
  await db.$executeRawUnsafe('DROP TRIGGER fail_guest_link ON "AnonymousChatRequest"');
  const persisted = await store.persistGuestUserMessage({ ...atomic, attempt: 1 });
  check(Boolean(persisted) && await db.anonymousMessage.count({ where: { sessionId: atomic.sessionId } }) === 1, 'retry after rollback persists one message');
  const signal = new AbortController().signal;
  let calls = 0, slept = 0;
  const copied = await retry.waitForGuestTransfer({ signal, onWaiting() {},
    request: async () => ++calls < 5 ? { status: 409, code: 'in_progress' } : { status: 200, copied: 2 },
    sleep: async ms => { slept += ms; } });
  check(copied === 2 && calls === 5 && slept > 1500, 'transfer retries beyond the old single retry');
  calls = 0;
  await assert.rejects(() => retry.waitForGuestTransfer({ signal, onWaiting() {}, request: async () => { calls++; return { status: 503 }; }, sleep: async () => {} }), retry.GuestTransferPendingError);
  check(calls === 9, 'retry budget is bounded');
  const abort = new AbortController(); abort.abort(); calls = 0;
  await assert.rejects(() => retry.waitForGuestTransfer({ signal: abort.signal, onWaiting() {}, request: async () => { calls++; return { status: 200 }; } }));
  check(calls === 0, 'cancelled account/page cannot start transfer');
  const stream = load('src/lib/chatStream.ts');
  const streamAbort = new AbortController(); let cancelled = false;
  const stalled = new ReadableStream({ cancel() { cancelled = true; } });
  const consuming = stream.consumeOpenAIChatStream(stalled, () => {}, streamAbort.signal);
  streamAbort.abort(); await assert.rejects(() => consuming);
  check(cancelled, 'aborted stalled AI body is cancelled instead of renewing forever');
  const { NextRequest } = require('next/server');
  const handler = load('src/lib/anonymousChat.ts', {
    '@/lib/apiI18n': { getApiLocale: () => 'ru' },
    '@/lib/chatHelpers': { resolveChatSystemPrompt: () => 'Test', trimMessagesToTokenLimit: messages => ({ messages }),
      streamChatCompletion: async () => { throw new Error('synthetic upstream failure'); } },
    '@/lib/logger': { errorLog() {}, toSafeDiagnostic: () => ({ category: 'error' }) },
  });
  const request = (sessionId) => new NextRequest('http://localhost/api/chat/test', {
    method: 'POST', headers: { cookie: `anonymousSessionId=${sessionId}` },
  });
  const originalModel = db.model.findFirst;
  db.model.findFirst = async () => { throw new Error('synthetic model preparation failure'); };
  let response;
  try { response = await handler.handleAnonymousChatPost(request('guest-handler-model'), character.id,
    { message: 'hello', requestId: 'handler-model-request' }); }
  finally { db.model.findFirst = originalModel; }
  check(response.status === 500 && await quota('guest-handler-model') === 0, 'real handler preparation failure refunds quota');
  const model = await db.model.create({ data: { name: 'guest-test-model', displayName: 'Test', priceVC: 1, isActive: true } });
  const originalHistory = db.anonymousMessage.findMany;
  db.anonymousMessage.findMany = async () => { throw new Error('synthetic history preparation failure'); };
  try { response = await handler.handleAnonymousChatPost(request('guest-handler-history'), character.id,
    { message: 'hello', requestId: 'handler-history-request' }); }
  finally { db.anonymousMessage.findMany = originalHistory; }
  check(response.status === 500 && await quota('guest-handler-history') === 0, 'real handler history failure refunds quota');
  await db.model.delete({ where: { id: model.id } });
  if (process.env['GUEST_TEST_BROWSER'] === '1') {
    const { verifyGuestBrowser } = await import('./browser-guest-p1.mjs');
    await verifyGuestBrowser({ db, databaseUrl: browserDatabaseUrl, store, character, user, check });
  }
  console.log(`${process.env['P1_CLOSURE'] === '1' ? 'P1 closure' : 'Guest P1'}: ${checks} checks passed on private PostgreSQL`);
} finally {
  await db.$disconnect();
  // Native pg_ctl shuts down this exact private cluster; never kills by shared port.
  if (process.platform === 'win32') {
    const stop = spawnSync(join(resolve(runtime), 'node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe'),
      ['stop', '-D', join(directory, 'db'), '-m', 'fast', '-w'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (stop.status !== 0) throw new Error('Private PostgreSQL shutdown failed');
  } else await pg.stop();
}
