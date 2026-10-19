// Isolated PostgreSQL, synthetic users/messages and a fake audio provider. Never loads .env.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import ts from 'typescript';
import pg from 'pg';

const require = createRequire(import.meta.url);
process.env.CHAT_THREADS_ENABLED = 'true';
const { NextRequest } = require('next/server');
const root = process.cwd();
const fixture = mkdtempSync(join(root, '.runtime', 'speech-db-'));
const runtime = resolve(process.env.GUEST_TEST_RUNTIME || '.runtime/speech-test-runtime');
const { default: getBinaries } = await import(pathToFileURL(join(runtime, 'node_modules/embedded-postgres/dist/binary.js')).href);
const binaries = await getBinaries();
const port = await new Promise(done => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const databaseDir = join(fixture, 'db');
const url = `postgresql://postgres@127.0.0.1:${port}/postgres?connection_limit=12`;
const db = new PrismaClient({ datasourceUrl: url, log: [] });
const ddl = new pg.Client({ connectionString: url });
const run = (file, args, options = {}) => {
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, ...options });
  if (r.status !== 0) throw new Error(`${file} failed: ${r.stderr || r.stdout || r.error}`);
  return r;
};
const audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(160, 1)]);
let sessionUser = 'free', providerCalls = 0, providerFailure = false, providerState = 'ready', pollFailure = false, downloadFailure = false;
class FixtureProviderError extends Error { constructor(status, definitive = false) { super('Speech provider unavailable'); this.status = status; this.definitive = definitive; } }
const provider = { SPEECH_MODEL: 'google/gemini-3-8-flash-lite-tts', SPEECH_CACHE_VERSION: 'gemini-lite-native-v1-mp3-64', speechEnabled: () => true,
  SpeechProviderError: FixtureProviderError,
  submitSpeech: async () => { providerCalls++; if (providerFailure) throw new FixtureProviderError(503, true); return 'task_' + providerCalls; },
  getSpeechTask: async () => { if (pollFailure) throw new FixtureProviderError(401, true); return { state: providerState, credits: .47, url: 'https://tempfile.aiquickdraw.com/speech.wav' }; },
  downloadSpeech: async () => { if (downloadFailure) throw new FixtureProviderError(); return audio; } };
const lame = await import('@breezystack/lamejs');
const mocks = {
  '@breezystack/lamejs': lame,
  '@/lib/prisma': { prisma: db }, '@/lib/auth': { authOptions: {} },
  'next-auth/next': { getServerSession: async () => sessionUser ? { user: { id: sessionUser } } : null },
  '@/lib/telegram/catalog': { isCharacterAllowedInTelegram: async () => true },
  '@/lib/subscriptionState': { applyPendingSubscriptionIfDue: async id => db.user.findUnique({ where: { id } }) },
  '@/lib/logger': { errorLog() {}, toSafeDiagnostic: () => ({}) },
  '@/lib/aiCostTelemetry': { withAiCostContext: fn => fn(), setAiCostActor() {}, recordKieSpeechCost: async () => {} },
};
function loader(overrides = {}) {
  const cache = new Map();
  const load = file => {
    file = resolve(file);
    if (cache.has(file)) return cache.get(file);
    if (file.endsWith('speechProvider.ts') && !overrides.realProvider) return provider;
    const loadedModule = { exports: {} }; cache.set(file, loadedModule.exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const dependency = name => {
      if (name in overrides) return overrides[name];
      if (name in mocks) return mocks[name];
      const base = name.startsWith('@/') ? join(root, 'src', name.slice(2)) : name.startsWith('.') ? resolve(dirname(file), name) : null;
      if (!base) return require(name);
      if (base.endsWith('telegram/catalog')) return mocks['@/lib/telegram/catalog'];
      if (base.endsWith('aiCostTelemetry')) return mocks['@/lib/aiCostTelemetry'];
      const target = existsSync(base + '.ts') ? base + '.ts' : existsSync(base + '.js') ? base + '.js' : base;
      if (target.endsWith('.json')) return require(target);
      return load(target);
    };
    new Function('require', 'module', 'exports', code)(dependency, loadedModule, loadedModule.exports);
    cache.set(file, loadedModule.exports); return loadedModule.exports;
  };
  return load;
}
let checks = 0, started = false;
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log(`PASS ${label}`); };
const rejects = async (fn, code, label) => { await assert.rejects(fn, error => error.code === code); check(true, label); };
const now = new Date('2026-10-19T12:00:00Z');
const source = (messageId, userId = 'free', voice = 'Fola') => ({ userId, characterId: 'hero', messageId, voice });
const context = { params: Promise.resolve({ id: 'hero' }) };
const request = (messageId, extra = {}, init = {}) => new NextRequest('http://localhost/api/chat/hero/speech?thread=story-free', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', ...init.headers },
  body: JSON.stringify({ messageId, ...extra }), ...init,
});
try {
  run(binaries.initdb, ['-D', databaseDir, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C']);
  run(binaries.pg_ctl, ['-D', databaseDir, '-l', join(fixture, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1`, '-w', 'start'], { stdio: 'ignore' }); started = true;
  const schema = join(fixture, 'schema.prisma');
  writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace(/Unsupported\("vector\(\d+\)"\)/g, 'Bytes'));
  run(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', schema], {
    cwd: fixture, env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url, MIGRATION_DATABASE_URL: url }, timeout: 120_000,
  });
  await ddl.connect();
  // Apply the real migration independently of Prisma's schema creation.
  await ddl.query('DROP TABLE "SpeechClip"; DROP TABLE "SpeechDailyQuota";');
  await ddl.query(readFileSync('prisma/migrations/20261019190000_character_speech/migration.sql', 'utf8'));
  await ddl.query(readFileSync('prisma/migrations/20261019230000_kie_character_speech/migration.sql', 'utf8'));
  const load = loader();
  const service = load('src/lib/chatSpeech.ts');
  const shared = load('src/lib/speech.ts');
  const speechCases = [
    ['*Подошёл.* **Привет** [друг](https://example.test)\n```code```', 'Привет друг'],
    ['*улыбнулась и села рядом*', ''],
    ['_смотрит в окно_ Привет! (тихо)', 'Привет!'],
    ['*улыбается* Привет! *неоконченная ремарка', 'Привет!'],
    ['Она улыбнулась. «Привет!» — сказала она. «Как дела?»', 'Привет! Как дела?'],
    ['Тихо открылась дверь.\n— Привет! — сказала она. — Как дела?\nОна села рядом.', 'Привет! Как дела?'],
    ['— Я — твой друг.', 'Я — твой друг.'],
    ['Привет!\n1. Открыть дверь\n2. Пойти к окну', 'Привет!'],
    ['<em>улыбнулась</em> Hello! [waves]', 'Hello!'],
    ['Hello, my friend!', 'Hello, my friend!'],
    ['«Привет!» (она (тихо) улыбнулась)', 'Привет!'],
  ];
  for (const [input, expected] of speechCases) check(shared.speechText(input) === expected, `speech extraction: ${JSON.stringify(input).slice(0, 75)}`);
  for (const id of ['free', 'paid', 'expired', 'other']) {
    await db.user.create({ data: { id, subscriptionType: id === 'paid' || id === 'expired' ? 'dialog' : 'start',
      subscriptionEnd: id === 'paid' ? new Date('2099-01-01') : id === 'expired' ? new Date('2020-01-01') : null } });
  }
  await db.character.create({ data: { id: 'hero', userId: 'other', name: 'Synthetic hero', isPublic: true } });
  const add = async (id, userId = 'free', role = 'assistant', content = 'Привет! Как прошёл твой день?') => {
    const threadId = `story-${userId}`;
    await db.chatThread.upsert({ where: { id: threadId }, create: { id: threadId, userId, characterId: 'hero', number: 1 }, update: {} });
    return db.message.create({ data: { id, userId, characterId: 'hero', threadId, role, content } });
  };
  await add('one'); await add('two');
  const races = await Promise.allSettled(Array.from({ length: 12 }, () => service.reserveSpeech(source('one'), now)));
  const winners = races.filter(r => r.status === 'fulfilled');
  check(winners.length === 1 && races.filter(r => r.status === 'rejected' && r.reason.code === 'busy').length === 11, 'parallel requests reserve exactly one generation across connections');
  const first = winners[0].value.reservation;
  await service.failSpeech(first);
  check((await service.getSpeechQuota('free', now)).remaining === 1, 'provider failure preserves the daily allowance');
  const success = await service.reserveSpeech(source('one'), now);
  await service.finishSpeech(success.reservation, audio, now);
  await rejects(() => service.reserveSpeech(source('one'), now), 'quota', 'cached replay cannot bypass the free daily playback allowance');
  const replayDay = new Date('2026-10-19T21:00:01Z');
  const replay = await service.reserveSpeech(source('one'), replayDay);
  check(replay.kind === 'cached' && replay.audio.equals(audio) && replay.quota.remaining === 0, 'next-day replay returns cached bytes and spends one playback');
  check((await db.speechClip.findFirst()).expiresAt.getTime() === replayDay.getTime() + 7 * 86_400_000, 'cache remains for seven days after its last authorized playback');
  const cachedRaceDay = new Date('2026-10-20T21:00:01Z');
  const cachedRaces = await Promise.allSettled(Array.from({ length: 12 }, () => service.reserveSpeech(source('one'), cachedRaceDay)));
  check(cachedRaces.filter(r => r.status === 'fulfilled' && r.value.kind === 'cached').length === 1
    && cachedRaces.filter(r => r.status === 'rejected' && r.reason.code === 'quota').length === 11, 'parallel cache hits grant exactly one free playback');
  await rejects(() => service.reserveSpeech(source('two'), now), 'quota', 'a second free reply is refused');
  await db.message.delete({ where: { id: 'one' } });
  check(await db.speechClip.count() === 0, 'message deletion removes its cached audio');
  await rejects(() => service.reserveSpeech(source('two'), now), 'quota', 'deleting a message cannot reset the daily allowance');
  check((await service.getSpeechQuota('free', new Date('2026-10-21T20:59:59Z'))).remaining === 0, 'playback remains spent immediately before Moscow midnight');
  const tomorrow = new Date('2026-10-21T21:00:01Z');
  const next = await service.reserveSpeech(source('two'), tomorrow);
  check(next.kind === 'reserved', 'allowance resets at Moscow midnight');
  await service.failSpeech(next.reservation);
  for (let n = 0; n < 3; n++) {
    await add(`paid-${n}`, 'paid');
    const p = await service.reserveSpeech(source(`paid-${n}`, 'paid'), now);
    check((await service.finishSpeech(p.reservation, audio, now)).unlimited, `paid subscription permits generation ${n + 1}`);
  }
  check(await db.speechDailyQuota.count({ where: { userId: 'paid' } }) === 0, 'paid generations do not consume a free daily quota');
  await add('expired-one', 'expired'); await add('expired-two', 'expired');
  const expired = await service.reserveSpeech(source('expired-one', 'expired'), now);
  await service.finishSpeech(expired.reservation, audio, now);
  await rejects(() => service.reserveSpeech(source('expired-two', 'expired'), now), 'quota', 'expired subscriptions receive only one free generation');
  check(!service.unlimitedSpeech({ subscriptionType: 'invented-plan', subscriptionEnd: new Date('2099-01-01') }, now), 'an unknown plan never grants unlimited speech');
  check(service.unlimitedSpeech({ subscriptionType: 'history', subscriptionEnd: new Date('2099-01-01') }, now), 'legacy paid History plans retain unlimited speech');
  await rejects(() => service.reserveSpeech(source('two', 'other'), now), 'notFound', 'another user cannot synthesize a private message');
  await add('user-message', 'other', 'user');
  await rejects(() => service.reserveSpeech(source('user-message', 'other'), now), 'notFound', 'user messages cannot be synthesized');
  await add('only-action', 'other', 'assistant', '*Она задумалась и посмотрела в окно.*');
  await rejects(() => service.reserveSpeech(source('only-action', 'other'), now), 'empty', 'action-only replies never reserve or spend a paid generation');
  check((await service.getSpeechQuota('other', now)).remaining === 1, 'action-only replies preserve the free playback');
  await add('edited', 'other');
  const edit = await service.reserveSpeech(source('edited', 'other'), now);
  await db.message.update({ where: { id: 'edited' }, data: { content: 'Изменённая реплика' } });
  await rejects(() => service.finishSpeech(edit.reservation, audio, now), 'changed', 'an edit during synthesis cannot publish outdated audio');
  await service.failSpeech(edit.reservation);
  check((await service.getSpeechQuota('other', now)).remaining === 1, 'an edited or deleted reply does not spend the allowance');
  const oldLease = await service.reserveSpeech(source('edited', 'other'), now);
  const replacement = await service.reserveSpeech(source('edited', 'other'), new Date(now.getTime() + 121_000));
  await service.failSpeech(oldLease.reservation);
  check(Boolean(await db.speechClip.findFirst({ where: { requestToken: replacement.reservation.token } })), 'late failure cannot release another request lease');
  await service.failSpeech(replacement.reservation);
  await add('long', 'other', 'assistant', 'а'.repeat(8_001));
  await rejects(() => service.reserveSpeech(source('long', 'other'), now), 'tooLong', 'oversized input is rejected before any paid call');

  // Real API handler, real ownership/scope resolution, fake paid provider.
  const routes = load('src/app/api/chat/[id]/speech/route.ts');
  sessionUser = null;
  check((await routes.POST(request('two'), context)).status === 401, 'unauthenticated API request is refused');
  sessionUser = 'other';
  check((await routes.POST(request('two'), context)).status === 404, 'API cannot synthesize another owner message');
  sessionUser = 'free';
  await db.chatThread.create({ data: { id: 'story-free-second', userId: 'free', characterId: 'hero', number: 2 } });
  await db.message.create({ data: { id: 'other-story-reply', userId: 'free', characterId: 'hero', threadId: 'story-free-second', role: 'assistant', content: 'Different story' } });
  check((await routes.POST(request('other-story-reply'), context)).status === 404, 'API isolates separate stories owned by the same user');
  check((await routes.POST(request('two', { voice: 'untrusted-voice' }), context)).status === 400, 'invalid voice never reaches the provider');
  check((await routes.POST(request('two', {}, { headers: { Origin: 'https://attacker.invalid' } }), context)).status === 403, 'cross-origin synthesis is refused');
  await db.speechDailyQuota.deleteMany({ where: { userId: 'free' } });
  providerFailure = true;
  check((await routes.POST(request('two'), context)).status === 503, 'provider failure is a controlled API error');
  check((await service.getSpeechQuota('free')).remaining === 1, 'API failure releases its reservation');
  providerFailure = false;
  const response = await routes.POST(request('two'), context);
  check(response.status === 200 && response.headers.get('content-type') === 'audio/mpeg'
    && response.headers.get('cache-control') === 'private, no-store', 'successful API returns private binary audio');
  const calls = providerCalls;
  check((await routes.POST(request('two'), context)).status === 429 && providerCalls === calls, 'API refuses a second free playback even on a cache hit');
  await db.speechDailyQuota.deleteMany({ where: { userId: 'free' } });
  const cachedAccess = await routes.POST(request('two'), context);
  check(cachedAccess.status === 200 && cachedAccess.headers.get('X-Speech-Remaining') === '0' && providerCalls === calls, 'cached API access spends a fresh allowance without another provider call');
  await add('new-free');
  const denied = await routes.POST(request('new-free'), context);
  check(denied.status === 429 && (await denied.json()).code === 'quota', 'API enforces one successful free reply per day');
  const status = await routes.GET(new NextRequest('http://localhost/api/chat/hero/speech?thread=story-free'), context);
  check((await status.json()).remaining === 0, 'quota status agrees with the generation API');
  sessionUser = 'paid';
  const paidReq = id => new NextRequest('http://localhost/api/chat/hero/speech?thread=story-paid', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify({ messageId: id }),
  });
  const paidApi = await routes.POST(paidReq('paid-0'), context);
  check(paidApi.status === 200 && paidApi.headers.get('X-Speech-Unlimited') === 'true', 'paid API response confirms unlimited entitlement');
  const paidCalls = providerCalls;
  check((await routes.POST(paidReq('paid-0'), context)).status === 200 && providerCalls === paidCalls, 'subscribers replay cached recordings without quota or another paid call');
  await db.speechClip.updateMany({ where: { userId: 'paid' }, data: { expiresAt: new Date('2020-01-01') } });
  const purged = await service.cleanupSpeechCache();
  check(purged.clips > 0 && (await service.getSpeechQuota('free')).remaining === 0, 'audio cleanup preserves the successful free daily debit');
  check((await routes.POST(paidReq('paid-0'), context)).status === 200, 'paid users can regenerate an expired recording');

  // Durable async jobs: polling, reconnects and failures must not purchase a second synthesis.
  await db.speechDailyQuota.deleteMany({ where: { userId: 'free' } });
  sessionUser = 'free';
  await add('pending-free'); providerState = 'pending';
  const pending = await routes.POST(request('pending-free'), context), submittedCalls = providerCalls;
  check(pending.status === 202 && pending.headers.get('retry-after') === '4', 'pending synthesis returns a bounded polling response');
  check((await service.getSpeechQuota('free')).remaining === 1, 'pending task does not consume the free playback');
  const savedPending = await db.speechClip.findFirst({ where: { messageId: 'pending-free' } });
  check(Boolean(savedPending.providerTaskId && savedPending.costEventId), 'provider job and accounting identity survive a reconnect');
  await routes.POST(request('pending-free'), context);
  check(providerCalls === submittedCalls, 'repeated pending polls never submit another paid task');
  await add('while-pending');
  check((await routes.POST(request('while-pending'), context)).status === 409, 'another reply cannot create a parallel pending task');
  pollFailure = true;
  check((await routes.POST(request('pending-free'), context)).status === 503, 'poll authentication failure is controlled');
  check(Boolean((await db.speechClip.findFirst({ where: { messageId: 'pending-free' } })).providerTaskId), 'poll errors retain a known paid task even when the error is definitive for that HTTP call');
  pollFailure = false; providerState = 'ready'; downloadFailure = true;
  check((await routes.POST(request('pending-free'), context)).status === 503, 'audio download failure is controlled');
  check((await service.getSpeechQuota('free')).remaining === 1, 'download failure preserves playback allowance');
  downloadFailure = false;
  const resumed = await routes.POST(request('pending-free'), context);
  check(resumed.status === 200 && providerCalls === submittedCalls, 'ready task resumes after poll/download errors without another synthesis');
  check((await service.getSpeechQuota('free')).remaining === 0, 'completed resumed task debits playback exactly once');

  await db.speechDailyQuota.deleteMany({ where: { userId: 'free' } });
  await add('lost-acceptance');
  const uncertain = await service.reserveSpeech(source('lost-acceptance'));
  await service.deferSpeech(uncertain.reservation);
  const beforeUnknown = providerCalls;
  const unknownReply = await routes.POST(request('lost-acceptance'), context);
  check(unknownReply.status === 503 && (await unknownReply.json()).code === 'uncertain' && providerCalls === beforeUnknown, 'lost submission response never causes a duplicate paid creation');
  check((await service.getSpeechQuota('free')).remaining === 1, 'uncertain acceptance preserves free quota');
  await add('terminal-failure'); providerState = 'failed';
  check((await routes.POST(request('terminal-failure'), context)).status === 503, 'terminal provider failure is controlled');
  check(!await db.speechClip.findFirst({ where: { messageId: 'terminal-failure' } }), 'definitively failed task releases its reservation');
  providerState = 'ready';

  // Delivery, rather than submission, determines the day and subscription entitlement.
  await db.speechDailyQuota.deleteMany({ where: { userId: 'free' } });
  await add('midnight-delivery');
  const midnightStart = new Date('2026-10-24T20:59:55Z'), midnightEnd = new Date('2026-10-24T21:00:05Z');
  const midnightJob = await service.reserveSpeech(source('midnight-delivery'), midnightStart);
  await service.finishSpeech(midnightJob.reservation, audio, midnightEnd);
  check((await service.getSpeechQuota('free', midnightEnd)).remaining === 0
    && (await service.getSpeechQuota('free', midnightStart)).remaining === 1, 'queued delivery across Moscow midnight debits the delivery day');
  await add('paid-expiry', 'paid');
  const expiringJob = await service.reserveSpeech(source('paid-expiry', 'paid'), midnightStart);
  await db.user.update({ where: { id: 'paid' }, data: { subscriptionEnd: midnightStart } });
  check(!(await service.finishSpeech(expiringJob.reservation, audio, midnightEnd)).unlimited
    && (await service.getSpeechQuota('paid', midnightEnd)).remaining === 0, 'subscription expiring in the queue receives the free delivery allowance');

  // Exercise the real accounting writer against the isolated database.
  const costSource = readFileSync('src/lib/aiCostTelemetry.ts', 'utf8');
  const costFunction = costSource.slice(costSource.indexOf('export async function recordKieSpeechCost'), costSource.indexOf('function providerUsage'));
  const costModule = { exports: {} };
  new Function('exports', 'contexts', 'prisma', 'getAccountingUsdRub', 'createHmac', 'errorLog', 'toSafeDiagnostic',
    ts.transpileModule(costFunction, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(
    costModule.exports, { getStore: () => ({ actorHash: 'synthetic-actor' }) }, db, async () => 100,
    () => { throw Error('unexpected HMAC'); }, (_scope, _message, error) => { throw new Error(error.message); }, e => ({ message: e.message }));
  const costJob = { costEventId: 'synthetic-speech-cost', userId: 'free', providerTaskId: 'task_cost', text: 'Тест', startedAt: new Date() };
  await costModule.exports.recordKieSpeechCost(costJob, provider.SPEECH_MODEL, 'pending');
  await costModule.exports.recordKieSpeechCost(costJob, provider.SPEECH_MODEL, 'completed', .47);
  await costModule.exports.recordKieSpeechCost(costJob, provider.SPEECH_MODEL, 'pending');
  const receipt = await db.aiCostEvent.findUnique({ where: { id: costJob.costEventId } });
  check(receipt?.outcome === 'completed' && receipt.providerCostNative === .47 && receipt.providerCostCurrency === 'CREDIT'
    && Math.abs(receipt.estimatedCostRub - .235) < .00001 && receipt.reportedCostRub === null, 'one cost receipt preserves measured Kie credits and keeps estimated RUB separate from actual ledger debits');
  check(await db.aiCostEvent.count({ where: { id: costJob.costEventId } }) === 1, 'polling does not duplicate cost events or regress completed accounting');

  // Real adapter and MP3 encoding; synthetic network responses only.
  process.env.KIE_API_KEY = 'synthetic-kie-key';
  const wav = Buffer.alloc(44 + 48000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(48000, 40);
  for (let i = 0; i < 24000; i++) wav.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / 24000) * 10000), 44 + i * 2);
  const real = loader({ realProvider: true })('src/lib/speechProvider.ts');
  const nativeFetch = globalThis.fetch; let mode = 'ok', captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url, init });
    if (mode === 'http') return new Response('{}', { status: 503 });
    if (mode === 'refused') return Response.json({ code: 402, msg: 'sensitive provider text' });
    if (mode === 'network') throw Error('sensitive network failure');
    if (String(url).includes('createTask')) return Response.json({ code: 200, data: { taskId: 'task_fixed' } });
    if (String(url).includes('recordInfo')) return Response.json({ code: 200, data: { taskId: 'task_fixed', model: mode === 'wrong-model' ? 'untrusted/model' : real.SPEECH_MODEL,
      state: mode === 'pending' ? 'generating' : 'success', creditsConsumed: .47,
      resultJson: JSON.stringify({ resultUrls: [mode === 'unsafe-url' ? 'https://attacker.invalid/a.wav' : 'https://tempfile.aiquickdraw.com/speech.wav'] }) } });
    return new Response(mode === 'html' ? '<html>error</html>' : mode === 'large' ? Buffer.alloc(40 * 1024 * 1024 + 1) : wav);
  };
  try {
    check(await real.submitSpeech('Встречаемся 21 октября в 19:30.', 'Fola') === 'task_fixed', 'Kie accepts fixed Gemini task submission');
    const submission = captured[0], body = JSON.parse(submission.init.body);
    check(submission.url === 'https://api.kie.ai/api/v1/jobs/createTask' && submission.init.redirect === 'error'
      && body.model === 'google/gemini-3-8-flash-lite-tts' && body.input.speakers[0].voice_name === 'Fola'
      && body.input.filler_words === false && body.input.dialogue_turns[0].style.includes('без иностранного акцента'), 'fixed model, approved voice, native pronunciation and no filler words');
    check(real.speechInput('Hello, 21 October.', 'Fenrir').dialogue_turns[0].style.includes('original language'), 'English speech does not receive a Russian pronunciation instruction');
    mode = 'pending'; check((await real.getSpeechTask('task_fixed')).state === 'pending', 'generating job remains pending');
    mode = 'ok'; const ready = await real.getSpeechTask('task_fixed');
    check(ready.state === 'ready' && ready.credits === .47, 'provider-reported credits accompany completed task');
    const compressed = await real.downloadSpeech(ready.url);
    check(compressed.length > 1000 && compressed.length < wav.length / 3 && compressed[0] === 255, 'real mono WAV is encoded into compact valid MP3');
    check(!captured.at(-1).init.headers && captured.at(-1).init.redirect === 'error', 'media download forwards no API key and follows no redirect');
    for (const testMode of ['wrong-model', 'unsafe-url']) {
      mode = testMode; await assert.rejects(() => real.getSpeechTask('task_fixed'), /Speech provider unavailable/); check(true, 'provider rejects ' + testMode);
    }
    for (const testMode of ['http', 'refused', 'network']) {
      mode = testMode; await assert.rejects(() => real.submitSpeech('Тест', 'Fola'), e => e instanceof real.SpeechProviderError && e.definitive === (testMode === 'refused')); check(true, 'submission classifies ' + testMode + ' without leaking provider text');
    }
    for (const testMode of ['html', 'large']) {
      mode = testMode; await assert.rejects(() => real.downloadSpeech('https://tempfile.aiquickdraw.com/speech.wav'), /Speech provider unavailable/); check(true, 'provider rejects ' + testMode + ' audio');
    }
    const beforeUnsafe = captured.length;
    await assert.rejects(() => real.downloadSpeech('https://attacker.invalid/audio.wav'));
    check(captured.length === beforeUnsafe, 'untrusted media host is rejected before network access');
    const encoder = loader()('src/lib/speechAudio.ts');
    for (const invalid of [wav.subarray(0, wav.length - 1), Buffer.from(wav)]) {
      if (invalid.length === wav.length) invalid.writeUInt32LE(44100, 24);
      await assert.rejects(() => encoder.speechWavToMp3(invalid)); check(true, 'encoder rejects truncated or unsupported WAV');
    }
  } finally { globalThis.fetch = nativeFetch; }
  console.log(`Speech verification: ${checks} passed`);
} finally {
  await ddl.end().catch(() => {}); await db.$disconnect();
  if (started) run(binaries.pg_ctl, ['-D', databaseDir, '-m', 'fast', '-w', 'stop']);
}
