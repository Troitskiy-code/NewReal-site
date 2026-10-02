// Private PostgreSQL + local fake providers only. Never loads .env or production DB.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

const require = createRequire(import.meta.url);
const runtime = process.env.GUEST_TEST_RUNTIME;
if (!runtime) throw new Error('Set GUEST_TEST_RUNTIME to the isolated embedded-postgres installation');
const EmbeddedPostgres = require(join(resolve(runtime), 'node_modules/embedded-postgres/dist/index.js')).default;
let createyaReject = true, embeddingFails = false;
const server = createServer((req, res) => {
  res.setHeader('X-KodikRouter-Request-Id', 'req_cost_fixture');
  if (req.url === '/embeddings') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (embeddingFails) { res.statusCode = 503; res.end('{}'); return; }
      const payload = JSON.parse(body);
      const texts = Array.isArray(payload.input) ? payload.input : [payload.input];
      res.end(JSON.stringify({ model: payload.model, usage: { total_tokens: 84 },
        data: texts.map((_text, index) => ({ index, embedding: [index + 1, ...Array(1535).fill(0)] })).reverse() }));
    });
  } else if (req.url === '/v1/run') {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = createyaReject ? 402 : 200;
    res.end(JSON.stringify(createyaReject ? { error: { code: 'insufficient_credits', message: 'secret_provider_response' } }
      : { id: 'run_provider_1', status: 'completed', output: { url: 'https://example.test/avatar' } }));
  } else if (req.url === '/stream' || req.url === '/zero' || req.url === '/fallback') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
      `data: ${JSON.stringify({ model: req.url === '/fallback' ? 'unpriced/fallback' : 'test/model', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, cost: req.url === '/zero' ? 0 : 0.3 } })}\n\n` +
      (req.url === '/stream' ? 'data: {"usage":{"prompt_tokens":1000,"completion_tokens":200}}\n\ndata: {"usage":{"cost":0.3}}\n\n' : '') +
      'data: [DONE]\n\n');
  } else if (req.url === '/no-usage') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: {"choices":[{"delta":{"content":"12345678"}}]}\n\ndata: [DONE]\n\n');
  } else if (req.url === '/fail') { res.statusCode = 503; res.end('{}'); }
  else {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 200 }, message: 'secret_provider_response' }));
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const providerUrl = `http://127.0.0.1:${server.address().port}`;
const axios = require('axios');
const originalAxiosPost = axios.post;
// Redirect only the real embedding URL to the local provider; forbid external requests.
axios.post = (url, body, config) => {
  const target = url === 'https://api.kodikrouter.ru/v1/embeddings' ? providerUrl + '/embeddings' : url;
  if (!String(target).startsWith(providerUrl + '/')) throw new Error('External provider calls forbidden in cost fixture');
  return originalAxiosPost.call(axios, target, body, config);
};
const portServer = createServer(); await new Promise(r => portServer.listen(0, '127.0.0.1', r));
const port = portServer.address().port; await new Promise(r => portServer.close(r));
const directory = mkdtempSync(join(tmpdir(), 'nv-economy-'));
const pg = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), user: 'postgres', password: 'synthetic_cost_test', port, persistent: true, onLog() {}, initdbFlags: ['--encoding=UTF8'] });
const url = `postgresql://postgres:synthetic_cost_test@127.0.0.1:${port}/nv_economy_test`;
let db = new PrismaClient({ datasourceUrl: url, log: [] });
const ddl = new Client({ connectionString: url });
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log(`PASS ${label}`); };
let userId, avatarFail = false, imageDownloadFail = false;
const cache = new Map();
function load(file) {
  file = resolve(file); if (cache.has(file)) return cache.get(file);
  const loaded = { exports: {} }; cache.set(file, loaded.exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const dependency = name => {
    if (name === '@/lib/prisma') return { prisma: file.endsWith('messageEmbeddings.ts')
      ? { $queryRaw: async () => [] } // Isolate provider accounting from pgvector lookup.
      : db };
    if (name === '@/lib/auth') return { authOptions: {} };
    if (name === 'next-auth/next') return { getServerSession: async () => ({ user: { id: userId } }) };
    if (name === '@/lib/createya') return { convertImageToPNG: async x => x,
      generateWithCreateya: async (_prompt, _reference, _model, onRun) => {
        await onRun?.('run_test_1');
        if (avatarFail) throw Object.assign(new Error('secret_provider_response'), { avatarQuotaRefundable: avatarFail === true }); return 'https://example.test/image'; },
      imageUrlToDataUrl: async () => { if (imageDownloadFail) throw new Error('download failed'); return 'data:image/png;base64,dGVzdA=='; } };
    if (name.startsWith('@/')) return load(join('src', name.slice(2) + '.ts'));
    if (name.startsWith('.')) { const target = resolve(dirname(file), name); return load(existsSync(target + '.ts') ? target + '.ts' : target + '.js'); }
    return require(name);
  };
  new Function('require','module','exports',code)(dependency,loaded,loaded.exports); return loaded.exports;
}
try {
  process.env.NEXTAUTH_SECRET = 'synthetic_cost_actor_hash'; process.env.CREATEYA_API_KEY = 'synthetic_not_used';
  delete process.env.AI_COST_RATES_RUB_JSON; delete process.env.KODIKROUTER_USAGE_COST_CURRENCY; delete process.env.AI_COST_USD_RUB;
  await pg.initialise(); await pg.start(); await pg.createDatabase('nv_economy_test'); await ddl.connect();
  for (const name of readdirSync('prisma/migrations').filter(n => /^\d+_/.test(n)).sort()) {
    const sql = readFileSync(join('prisma/migrations', name, 'migration.sql'), 'utf8')
      .replace('CREATE EXTENSION IF NOT EXISTS vector;', '-- omitted only for disposable fixture')
      .replace(/vector\(1536\)/g, 'BYTEA');
    await ddl.query(sql);
  }
  check(!!await db.aiCostEvent.count().then(() => true), 'fresh full migration chain includes cost collector');
  const math = load('src/lib/aiCostMath.ts'), avatars = load('src/lib/avatarEconomy.ts');
  const low = math.weightedRequestEconomy([{ requestShare: 0.7, vc: 4, inputRubPerMillion: 10, outputRubPerMillion: 20, inputTokens: 1000, outputTokens: 100 },
    { requestShare: 0.3, vc: 36, inputRubPerMillion: 100, outputRubPerMillion: 200, inputTokens: 1000, outputTokens: 100 }]);
  check(Math.abs(low.averageVc - 13.6) < 1e-9, 'model mix uses weighted VC, no 30% step');
  check(math.tokenCostRub(1000, 200, 10, 20) === 0.014, 'input and output prices separate');
  check(math.tokenCostRub(1000, 200, null, 20) === null, 'unknown rates never become zero');
  check(avatars.avatarMonthlyAllowance('dialog') === 9 && avatars.avatarMonthlyAllowance('history') === 25 && avatars.avatarMonthlyAllowance('universe') === 69, '10% avatar quotas from actual monthly prices');
  await db.model.create({ data: { name: 'test/model', displayName: 'Test', priceVC: 4, pricePer1MInput: 10, pricePer1MOutput: 20 } });
  const telemetry = load('src/lib/aiCostTelemetry.ts');
  await telemetry.withAiCostContext(async () => {
    telemetry.setAiCostActor('never_store_this_user', 'dialog');
    await telemetry.meteredPost('intent', providerUrl + '/ok', { model: 'test/model', messages: [{ content: 'secret_prompt' }] });
    const response = await telemetry.meteredChatFetch(providerUrl + '/stream', {}, 'test/model', 10);
    check((await response.text()).includes('answer'), 'SSE bytes remain unchanged');
    await telemetry.recordChatCostCharge(response.body, 4);
  });
  const main = await db.aiCostEvent.findFirst({ where: { purpose: 'chat' } });
  check(main.inputTokens === 1000 && main.outputTokens === 200 && main.estimatedCostRub === 0.014, 'SSE terminal usage counted once');
  check(main.reportedCostRub === null, 'unconfigured provider currency not guessed');
  check(main.chargedVC === 4, 'actual successful VC charge recorded');
  check(main.providerRequestId === 'req_cost_fixture', 'provider request reference available for invoice reconciliation');
  check(main.actorHash !== 'never_store_this_user' && main.actorHash?.length === 64, 'actor pseudonymized');
  await Promise.all(['actor_one', 'actor_two'].map(actor => telemetry.withAiCostContext(async () => {
    telemetry.setAiCostActor(actor, 'story');
    await telemetry.meteredPost('intent', providerUrl + '/ok', { model: 'test/model' });
  })));
  const concurrentActors = await db.aiCostEvent.findMany({ where: { purpose: 'intent', subscriptionType: 'story' } });
  check(new Set(concurrentActors.map(r => r.actorHash)).size === 2 && new Set(concurrentActors.map(r => r.operationId)).size === 2, 'concurrent operation contexts do not mix accounts');
  check(!JSON.stringify(await db.aiCostEvent.findMany()).includes('secret_'), 'no prompts keys or raw responses persisted');
  process.env.KODIKROUTER_USAGE_COST_CURRENCY = 'RUB';
  const reported = await telemetry.meteredChatFetch(providerUrl + '/stream', {}, 'test/model', 10); await reported.text();
  check((await db.aiCostEvent.findFirst({ where: { reportedCostRub: 0.3 } }))?.costSource === 'provider', 'reported amount only with explicit currency');
  const fallback = await telemetry.meteredChatFetch(providerUrl + '/no-usage', {}, 'test/model', 20); await fallback.text();
  check(!!await db.aiCostEvent.findFirst({ where: { usageSource: 'estimated', inputTokens: 20, outputTokens: 2 } }), 'missing SSE usage marked estimated');
  const failed = await telemetry.meteredChatFetch(providerUrl + '/fail', {}, 'test/model', 10);
  check(failed.status === 503 && !!await db.aiCostEvent.findFirst({ where: { outcome: 'failed', estimatedCostRub: null } }), 'failed attempt recorded as unknown not free');
  const zero = await telemetry.meteredChatFetch(providerUrl + '/zero', {}, 'test/model', 20); await zero.text();
  check(!!await db.aiCostEvent.findFirst({ where: { providerCostNative: 0, reportedCostRub: null, estimatedCostRub: 0.014 } }), 'provider zero does not claim bill-free usage');
  delete process.env.KODIKROUTER_USAGE_COST_CURRENCY;
  const changedModel = await telemetry.meteredChatFetch(providerUrl + '/fallback', {}, 'test/model', 20); await changedModel.text();
  check(!!await db.aiCostEvent.findFirst({ where: { actualModel: 'unpriced/fallback', estimatedCostRub: null, costSource: 'unknown' } }), 'unpriced provider fallback not billed at requested model quote');
  const beforeRetry = await db.aiCostEvent.count();
  const retry = load('src/lib/retryWithBackoff.ts');
  let attempts = 0;
  await retry.retryWithBackoff(() => telemetry.meteredPost('summary', providerUrl + (++attempts === 1 ? '/fail' : '/ok'), { model: 'test/model' }), { baseDelayMs: 1 });
  check(await db.aiCostEvent.count() === beforeRetry + 2, 'failed attempt and retry collected separately');
  await db.model.create({ data: { name: 'openai/text-embedding-3-small', displayName: 'Embedding fixture', priceVC: 0, pricePer1MInput: 10, pricePer1MOutput: 0 } });
  const memoryEmbeddings = load('src/lib/memoryEmbeddings.ts');
  const vectors = await telemetry.withAiCostContext(async () => {
    telemetry.setAiCostActor('dedup_actor', 'story');
    return memoryEmbeddings.fetchEmbeddings(['secret_memory_one', 'secret_memory_two'], 'synthetic_embedding_key');
  });
  check(vectors.length === 2 && vectors[0][0] === 1 && vectors[1][0] === 2, 'real semantic dedup preserves embedding batch order');
  const dedupEvents = await db.aiCostEvent.findMany({ where: { purpose: 'embedding' } });
  check(dedupEvents.length === 1 && dedupEvents[0].inputTokens === 84 && dedupEvents[0].outputTokens === 0
    && dedupEvents[0].usageSource === 'provider' && dedupEvents[0].estimatedCostRub === 0.00084,
    'semantic dedup batch records one cost event and embedding total_tokens');
  check(dedupEvents[0].actorHash?.length === 64 && dedupEvents[0].subscriptionType === 'story'
    && !JSON.stringify(dedupEvents).includes('secret_memory') && !JSON.stringify(dedupEvents).includes('synthetic_embedding_key'),
    'semantic dedup inherits actor context without storing input or API key');
  const beforeEmptyEmbeddings = await db.aiCostEvent.count();
  check((await memoryEmbeddings.fetchEmbeddings([], 'synthetic_embedding_key')).length === 0
    && await db.aiCostEvent.count() === beforeEmptyEmbeddings, 'empty dedup batch does not create cost event');
  embeddingFails = true;
  check(await memoryEmbeddings.maxSimilarityAgainst('secret_candidate', ['secret_existing'], 'synthetic_embedding_key') === null
    && !!await db.aiCostEvent.findFirst({ where: { purpose: 'embedding', outcome: 'failed', httpStatus: 503, costSource: 'unknown' } }),
    'failed semantic comparison retains fallback and records failed provider attempt');
  embeddingFails = false;
  const beforeRagEmbeddings = await db.aiCostEvent.count({ where: { purpose: 'embedding' } });
  const rag = load('src/lib/messageEmbeddings.ts');
  await rag.searchRelevantMessages('fixture_user', 'fixture_character', 'secret_rag_query', 'synthetic_embedding_key');
  check(await db.aiCostEvent.count({ where: { purpose: 'embedding' } }) === beforeRagEmbeddings + 1,
    'real RAG query also records one embedding cost event');
  process.env.YANDEX_TRANSLATE_COST_RUB_PER_MILLION_CHARS = '50';
  await telemetry.meteredTranslationFetch(providerUrl + '/ok', {}, 4);
  check(!!await db.aiCostEvent.findFirst({ where: { purpose: 'translation', inputCharacters: 4, inputTokens: null, estimatedCostRub: 0.0002 } }), 'translation counts characters separately from tokens');
  await telemetry.meteredLegacySubmission(providerUrl + '/ok', {}, 'test/image');
  check(!!await db.aiCostEvent.findFirst({ where: { purpose: 'legacy_generation', outcome: 'submitted', costSource: 'unknown' } }), 'async submission not mistaken for measured provider bill');
  process.env.CREATEYA_API_URL = providerUrl;
  const createya = load('src/lib/createya.ts');
  let rejected;
  try { await createya.generateWithCreateya('fixture', undefined, 'test/image'); } catch (error) { rejected = error; }
  check(rejected?.avatarQuotaRefundable === true, 'real Createya initial rejection carries safe quota refund marker');
  createyaReject = false; let observedRun;
  check(await createya.generateWithCreateya('fixture', undefined, 'test/image', async runId => { observedRun = runId; }) === 'https://example.test/avatar'
    && observedRun === 'run_provider_1', 'real Createya exposes run reference without copying response body');
  const user = await db.user.create({ data: { email: 'cost@example.test', subscriptionType: 'dialog', subscriptionEnd: new Date(Date.now() + 86400000), tokensUsedThisMonth: 8 } }); userId = user.id;
  const tokens = load('src/lib/avatarTokens.ts');
  const concurrent = await Promise.all([tokens.reserveAvatarGeneration(user.id), tokens.reserveAvatarGeneration(user.id)]);
  check(concurrent.filter(Boolean).length === 1, 'parallel reservations cannot exceed avatar budget');
  const reservation = concurrent.find(Boolean);
  await Promise.all([tokens.settleAvatarGeneration(reservation.id, false), tokens.settleAvatarGeneration(reservation.id, false)]);
  check((await db.user.findUnique({ where: { id: user.id } })).tokensUsedThisMonth === 8, 'refund idempotent');
  const old = await tokens.reserveAvatarGeneration(user.id);
  await db.user.update({ where: { id: user.id }, data: { lastTokenMonth: new Date(Date.now() + 10000), tokensUsedThisMonth: 1 } });
  await tokens.settleAvatarGeneration(old.id, false);
  check((await db.user.findUnique({ where: { id: user.id } })).tokensUsedThisMonth === 1, 'old refund cannot subtract new activation period');
  await db.user.update({ where: { id: user.id }, data: { tokensUsedThisMonth: 0, lastTokenMonth: new Date() } });
  const handler = load('src/app/api/generate-avatar/route.ts'), { NextRequest } = require('next/server');
  const request = modelId => new NextRequest('https://example.test/api/generate-avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test', modelId }) });
  const result = await handler.POST(request('gpt-image')); const body = await result.json();
  check(result.status === 200 && body.tokenStatus.monthlyRemaining === 8, 'GPT avatar consumes one generation and returns authoritative status');
  check((await db.avatarQuotaReservation.findFirst({ where: { userId: user.id, status: 'completed' } })).units === 1, 'GPT reservation stores one generation regardless of model multiplier');
  check(!!await db.aiCostEvent.findFirst({ where: { providerRequestId: 'run_test_1', quotaReservationId: { not: null } } }), 'avatar cost linked to provider run and quota reservation');
  await db.user.update({ where: { id: user.id }, data: { tokensUsedThisMonth: 8 } });
  const lastGeneration = await handler.POST(request('gpt-image'));
  check(lastGeneration.status === 200 && (await lastGeneration.json()).tokenStatus.monthlyRemaining === 0, 'GPT avatar can use the final remaining generation');
  const exhausted = await handler.POST(request('gpt-image'));
  check(exhausted.status === 402 && (await db.user.findUnique({ where: { id: user.id } })).tokensUsedThisMonth === 9, 'avatar generation rejected after monthly limit is exhausted');
  await db.user.update({ where: { id: user.id }, data: { tokensUsedThisMonth: 1 } });
  avatarFail = true; const rejection = await handler.POST(request('flux-kontext'));
  check(rejection.status === 500 && !JSON.stringify(await rejection.json()).includes('secret_provider_response'), 'avatar failure does not leak provider error');
  check((await db.user.findUnique({ where: { id: user.id } })).tokensUsedThisMonth === 1, 'failed provider refunds one reserved generation');
  avatarFail = 'timeout'; await handler.POST(request('flux-kontext'));
  check((await db.user.findUnique({ where: { id: user.id } })).tokensUsedThisMonth === 2 && !!await db.avatarQuotaReservation.findFirst({ where: { status: 'manual_review' } }), 'ambiguous provider failure keeps quota for reconciliation');
  avatarFail = false; imageDownloadFail = true; await handler.POST(request('flux-kontext'));
  check((await db.user.findUnique({ where: { id: user.id } })).tokensUsedThisMonth === 3, 'completed provider run not refunded on image download failure');
  const exportResult = spawnSync(process.execPath, ['scripts/report-ai-costs.mjs'], { encoding: 'utf8', env: { ...process.env, COST_REPORT_DATABASE_URL: url } });
  check(exportResult.status === 0, 'read-only cost report against private PostgreSQL');
  const report = JSON.parse(exportResult.stdout);
  check(report.coverage.unknownCost > 0 && report.coverage.reportedCost > 0 && report.coverage.estimatedCost > 0, 'report exposes all three cost classes');
  check(!JSON.stringify(report).includes(user.id) && !JSON.stringify(report).includes('secret_'), 'export excludes individual actor IDs and secrets');
  const calcArgs = ['--experimental-strip-types', '--import', './scripts/alias-register.mjs', 'scripts/economy-acquisition.ts'];
  const calc = spawnSync(process.execPath, calcArgs, { encoding: 'utf8', windowsHide: true });
  check(calc.status === 0, 'economic calculator completes without DB');
  const economy = JSON.parse(readFileSync('docs/universe-acquisition-economy.json','utf8'));
  const packs = economy.rows.filter(r => r.variant === 'firstPack129');
  check(new Set(packs.map(r => r.firstPackVc)).size === 1, 'same first pack VC across all scenarios');
  check(economy.rows.every(r => r.promoAiRub > 0), 'promo cost no longer cancels itself');
  check(economy.rows.every(r => Math.abs(r.profit - (r.netRevenue - r.variableCost - r.infraAndAcquisition)) < 0.03), 'profit identities include all modeled costs');
  check(economy.rows.filter(r => r.variant === 'control').every(r => r.carryoverLiabilityRub === 0), 'no invented carryover of expiring subscription VC');
  const snapshot = join(directory, 'cost-report.json'); writeFileSync(snapshot, JSON.stringify(report));
  const incomplete = spawnSync(process.execPath, calcArgs, { encoding: 'utf8', windowsHide: true, env: { ...process.env, ECONOMY_COST_REPORT: snapshot } });
  check(incomplete.status !== 0, 'incomplete/unpriced observed mix rejected instead of inventing margin');
  await ddl.query("CREATE ROLE nv_cost_app LOGIN PASSWORD 'synthetic_role_cost'");
  await ddl.query('GRANT USAGE ON SCHEMA public TO nv_cost_app');
  await ddl.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nv_cost_app');
  const adminDb = db;
  db = new PrismaClient({ datasourceUrl: `postgresql://nv_cost_app:synthetic_role_cost@127.0.0.1:${port}/nv_economy_test?connection_limit=1`, log: [] });
  cache.clear();
  const restrictedTelemetry = load('src/lib/aiCostTelemetry.ts');
  const restrictedTokens = load('src/lib/avatarTokens.ts');
  check((await restrictedTelemetry.meteredPost('intent', providerUrl + '/ok', { model: 'test/model' })).status === 200, 'collector works with no-DDL role and connection_limit=1');
  const restrictedReservation = await restrictedTokens.reserveAvatarGeneration(user.id);
  await restrictedTokens.settleAvatarGeneration(restrictedReservation.id, false);
  check(!!restrictedReservation, 'quota reservation/refund works with restricted application role');
  let denied;
  try { await db.$executeRawUnsafe('CREATE TABLE "NeverCreated" (id int)'); } catch (error) { denied = error; }
  check(!!denied, 'application cost role is denied DDL');
  await db.$disconnect(); db = adminDb;
  await ddl.query('ALTER TABLE "AiCostEvent" RENAME TO "AiCostEvent_disabled_fixture"');
  const stillWorks = await telemetry.meteredPost('intent', providerUrl + '/ok', { model: 'test/model' });
  check(stillWorks.status === 200, 'collector DB failure does not break provider result');
  console.log(`Economy/cost verification: ${checks} passed`);
} finally {
  axios.post = originalAxiosPost;
  console.log('Cost fixture cleanup: Prisma and SQL connection');
  await db.$disconnect(); await ddl.end().catch(() => {});
  console.log('Cost fixture cleanup: private PostgreSQL');
  await pg.stop().catch(() => {});
  console.log('Cost fixture cleanup: local HTTP server');
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  console.log('Cost fixture cleanup complete');
}
