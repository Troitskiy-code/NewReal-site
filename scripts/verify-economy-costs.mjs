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
const runtime = process.env['GUEST_TEST_RUNTIME'];
if (!runtime) throw new Error('Set GUEST_TEST_RUNTIME to the isolated embedded-postgres installation');
const EmbeddedPostgres = require(join(resolve(runtime), 'node_modules/embedded-postgres/dist/index.js')).default;
let createyaReject = true, embeddingFails = false, embeddingAlias = false, cbrRate = null;
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
      res.end(JSON.stringify({ id: 'gen_emb_fixture', model: embeddingAlias ? 'text-embedding-3-small' : payload.model, usage: { total_tokens: 84, cost: 0.8 },
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
      `data: ${JSON.stringify({ id: 'gen_chat_fixture', model: req.url === '/fallback' ? 'unpriced/fallback' : 'test/model', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, cost: req.url === '/zero' ? 0 : 0.3 } })}\n\n` +
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
    if (name === './currencyRates') return { getAccountingUsdRub: async () => cbrRate };
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
    if (name.startsWith('.')) {
      const target = resolve(dirname(file), name);
      if (target.endsWith('.json')) return JSON.parse(readFileSync(target, 'utf8'));
      return load(existsSync(target + '.ts') ? target + '.ts' : target + '.js');
    }
    return require(name);
  };
  new Function('require','module','exports',code)(dependency,loaded,loaded.exports); return loaded.exports;
}
try {
  process.env.NEXTAUTH_SECRET = 'synthetic_cost_actor_hash'; process.env.CREATEYA_API_KEY = 'synthetic_not_used';
  process.env['LOGTAIL_SOURCE_TOKEN'] = ''; process.env['LOGTAIL_INGESTING_HOST'] = '';
  for (const key of Object.keys(process.env)) if (/^(COST_REPORT_|KODIK_COST_|ECONOMY_COST_REPORT$|ECONOMY_OUTPUT_DIR$)/.test(key)) delete process.env[key];
  process.env['ECONOMY_OUTPUT_DIR'] = directory;
  delete process.env['AI_COST_RATES_RUB_JSON']; delete process.env['KODIKROUTER_USAGE_COST_CURRENCY']; delete process.env['AI_COST_USD_RUB'];
  await pg.initialise(); await pg.start(); await pg.createDatabase('nv_economy_test'); await ddl.connect();
  await ddl.query("SET TIME ZONE 'UTC'");
  for (const name of readdirSync('prisma/migrations').filter(n => /^\d+_/.test(n)).sort()) {
    if (name === '20261008160000_ai_cost_accounting_v2') {
      await ddl.query(`INSERT INTO "AiCostEvent" ("id", "operationId", "provider", "model", "purpose", "attempt", "outcome", "costSource", "reportedCostRub", "estimatedCostRub")
        VALUES ('legacy_fixture', 'legacy_operation', 'kodikrouter', 'legacy/model', 'legacy_fixture', 1, 'completed', 'provider', 42, 0.01)`);
    }
    const sql = readFileSync(join('prisma/migrations', name, 'migration.sql'), 'utf8')
      .replace('CREATE EXTENSION IF NOT EXISTS vector;', '-- omitted only for disposable fixture')
      .replace(/vector\(1536\)/g, 'BYTEA');
    await ddl.query(sql);
  }
  check(!!await db.aiCostEvent.count().then(() => true), 'fresh full migration chain includes cost collector');
  const legacy = await db.aiCostEvent.findUnique({ where: { id: 'legacy_fixture' } });
  check(legacy.accountingVersion === 1 && legacy.reportedCostRub === 42 && legacy.providerResponseId === null,
    'v2 upgrade preserves historical amounts without inventing semantics or IDs');
  const math = load('src/lib/aiCostMath.ts'), avatars = load('src/lib/avatarEconomy.ts');
  const low = math.weightedRequestEconomy([{ requestShare: 0.7, vc: 4, inputRubPerMillion: 10, outputRubPerMillion: 20, inputTokens: 1000, outputTokens: 100 },
    { requestShare: 0.3, vc: 36, inputRubPerMillion: 100, outputRubPerMillion: 200, inputTokens: 1000, outputTokens: 100 }]);
  check(Math.abs(low.averageVc - 13.6) < 1e-9, 'model mix uses weighted VC, no 30% step');
  check(math.tokenCostRub(1000, 200, 10, 20) === 0.014, 'input and output prices separate');
  check(math.tokenCostRub(1000, 200, null, 20) === null, 'unknown rates never become zero');
  const costUsage = math.readCostUsage({ usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.1,
    prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 } } });
  check(costUsage.inputTokens === 100 && costUsage.cachedInputTokens === 40 && costUsage.cacheWriteInputTokens === 20,
    'cache read/write remain subsets of total input tokens');
  check(math.resolveKodikCost('chat_completions', costUsage, 0.002, 90).estimatedCostRub === 9,
    'documented chat USD estimate never adds another ten percent');
  check(math.resolveKodikCost('embeddings', costUsage, 0.002, 90).estimatedCostRub === 0.002
    && math.resolveKodikCost('embeddings', costUsage, 0.002, 90).providerCostCurrency === null,
    'embedding uses RUB catalog and unverified native currency despite chat FX');
  check(math.resolveKodikCost('chat_completions', costUsage, 0.002, null).costSource === 'catalog_estimate',
    'no invented FX rate when setting is absent');
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
  check(main.reportedCostRub === null && main.providerCostCurrency === 'USD' && main.costSource === 'catalog_estimate',
    'documented chat currency does not turn unknown FX into a confirmed debit');
  check(main.chargedVC === 4, 'actual successful VC charge recorded');
  check(main.providerRequestId === 'req_cost_fixture', 'provider request reference available for invoice reconciliation');
  check(main.providerResponseId === 'gen_chat_fixture' && main.apiSurface === 'chat_completions'
    && main.accountingVersion === 2 && main.providerCostSemantics === 'gateway_total_usd',
    'SSE records separate gateway and response IDs with endpoint semantics');
  check(main.actorHash !== 'never_store_this_user' && main.actorHash?.length === 64, 'actor pseudonymized');
  await Promise.all(['actor_one', 'actor_two'].map(actor => telemetry.withAiCostContext(async () => {
    telemetry.setAiCostActor(actor, 'story');
    await telemetry.meteredPost('intent', providerUrl + '/ok', { model: 'test/model' });
  })));
  const concurrentActors = await db.aiCostEvent.findMany({ where: { purpose: 'intent', subscriptionType: 'story' } });
  check(new Set(concurrentActors.map(r => r.actorHash)).size === 2 && new Set(concurrentActors.map(r => r.operationId)).size === 2, 'concurrent operation contexts do not mix accounts');
  check(!JSON.stringify(await db.aiCostEvent.findMany()).includes('secret_'), 'no prompts keys or raw responses persisted');
  process.env['KODIKROUTER_USAGE_COST_CURRENCY'] = 'RUB';
  process.env['AI_COST_USD_RUB'] = '90';
  const reported = await telemetry.meteredChatFetch(providerUrl + '/stream', {}, 'test/model', 10); await reported.text();
  const converted = await db.aiCostEvent.findFirst({ where: { estimatedCostRub: 27 } });
  check(converted?.costSource === 'chat_usd_estimate' && converted.reportedCostRub === null && converted.usdRub === 90,
    'legacy shared RUB setting ignored; USD conversion is explicitly estimated');
  const fallback = await telemetry.meteredChatFetch(providerUrl + '/no-usage', {}, 'test/model', 20); await fallback.text();
  check(!!await db.aiCostEvent.findFirst({ where: { usageSource: 'estimated', inputTokens: 20, outputTokens: 2 } }), 'missing SSE usage marked estimated');
  const failed = await telemetry.meteredChatFetch(providerUrl + '/fail', {}, 'test/model', 10);
  check(failed.status === 503 && !!await db.aiCostEvent.findFirst({ where: { outcome: 'failed', estimatedCostRub: null } }), 'failed attempt recorded as unknown not free');
  const zero = await telemetry.meteredChatFetch(providerUrl + '/zero', {}, 'test/model', 20); await zero.text();
  check(!!await db.aiCostEvent.findFirst({ where: { providerCostNative: 0, reportedCostRub: null, estimatedCostRub: 0.014 } }), 'provider zero does not claim bill-free usage');
  delete process.env['KODIKROUTER_USAGE_COST_CURRENCY'];
  delete process.env['AI_COST_USD_RUB'];
  cbrRate = 91;
  const cbrResponse = await telemetry.meteredChatFetch(providerUrl + '/stream', {}, 'test/model', 20);
  await cbrResponse.text();
  check(!!await db.aiCostEvent.findFirst({ where: { costSource: 'chat_cbr_estimate', usdRub: 91, estimatedCostRub: 27.3 } }),
    'real collector records current CBR estimate separately from explicit FX');
  cbrRate = null;
  const changedModel = await telemetry.meteredChatFetch(providerUrl + '/fallback', {}, 'test/model', 20); await changedModel.text();
  check(!!await db.aiCostEvent.findFirst({ where: { actualModel: 'unpriced/fallback', estimatedCostRub: null, costSource: 'unknown' } }), 'unpriced provider fallback not billed at requested model quote');
  const beforeRetry = await db.aiCostEvent.count();
  const retry = load('src/lib/retryWithBackoff.ts');
  let attempts = 0;
  await retry.retryWithBackoff(() => telemetry.meteredPost('summary', providerUrl + (++attempts === 1 ? '/fail' : '/ok'), { model: 'test/model' }), { baseDelayMs: 1 });
  check(await db.aiCostEvent.count() === beforeRetry + 2, 'failed attempt and retry collected separately');
  await db.model.create({ data: { name: 'openai/text-embedding-3-small', displayName: 'Embedding fixture', priceVC: 0, pricePer1MInput: 10, pricePer1MOutput: 0 } });
  const memoryEmbeddings = load('src/lib/memoryEmbeddings.ts');
  process.env['AI_COST_USD_RUB'] = '90';
  process.env['KODIKROUTER_USAGE_COST_CURRENCY'] = 'USD';
  const vectors = await telemetry.withAiCostContext(async () => {
    telemetry.setAiCostActor('dedup_actor', 'story');
    return memoryEmbeddings.fetchEmbeddings(['secret_memory_one', 'secret_memory_two'], 'synthetic_embedding_key');
  });
  check(vectors.length === 2 && vectors[0][0] === 1 && vectors[1][0] === 2, 'real semantic dedup preserves embedding batch order');
  const dedupEvents = await db.aiCostEvent.findMany({ where: { purpose: 'embedding' } });
  check(dedupEvents.length === 1 && dedupEvents[0].inputTokens === 84 && dedupEvents[0].outputTokens === 0
    && dedupEvents[0].usageSource === 'provider' && dedupEvents[0].estimatedCostRub === 0.00084,
    'semantic dedup batch records one cost event and embedding total_tokens');
  check(dedupEvents[0].providerCostNative === 0.8 && dedupEvents[0].providerCostCurrency === null
    && dedupEvents[0].usdRub === null && dedupEvents[0].providerResponseId === 'gen_emb_fixture'
    && dedupEvents[0].apiSurface === 'embeddings' && dedupEvents[0].costSource === 'catalog_estimate',
    'real dedup embeds preserve native cost but ignore shared USD/FX interpretation');
  delete process.env['AI_COST_USD_RUB']; delete process.env['KODIKROUTER_USAGE_COST_CURRENCY'];
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
  await db.model.update({ where: { name: 'openai/text-embedding-3-small' }, data: { pricePer1MInput: null, pricePer1MOutput: null } });
  embeddingAlias = true;
  await memoryEmbeddings.fetchEmbeddings(['fixture_alias'], 'synthetic_embedding_key');
  check(!!await db.aiCostEvent.findFirst({ where: { actualModel: 'text-embedding-3-small', inputRubPerMillion: 1.95,
    outputRubPerMillion: 0, estimatedCostRub: 0.0001638, costSource: 'catalog_estimate' } }),
    'real embedding response alias retains 1.95 RUB snapshot when DB rates are absent');
  embeddingAlias = false;
  process.env['YANDEX_TRANSLATE_COST_RUB_PER_MILLION_CHARS'] = '50';
  await telemetry.meteredTranslationFetch(providerUrl + '/ok', {}, 4);
  check(!!await db.aiCostEvent.findFirst({ where: { purpose: 'translation', inputCharacters: 4, inputTokens: null, estimatedCostRub: 0.0002 } }), 'translation counts characters separately from tokens');
  await telemetry.meteredLegacySubmission(providerUrl + '/ok', {}, 'test/image');
  check(!!await db.aiCostEvent.findFirst({ where: { purpose: 'legacy_generation', outcome: 'submitted', costSource: 'unknown' } }), 'async submission not mistaken for measured provider bill');
  process.env['CREATEYA_API_URL'] = providerUrl;
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
  check(report.schemaVersion === 2 && report.coverage.unknownCost > 0 && report.coverage.confirmedCost === 0
    && report.coverage.estimatedCost > 0 && report.totals.legacyUnverifiedRub === 42,
    'report separates estimates/unknown/legacy amounts without claiming confirmed costs');
  check(!JSON.stringify(report).includes(user.id) && !JSON.stringify(report).includes('secret_'), 'export excludes individual actor IDs and secrets');
  const calcArgs = ['--experimental-strip-types', '--import', './scripts/alias-register.mjs', 'scripts/economy-acquisition.ts'];
  const calc = spawnSync(process.execPath, calcArgs, { encoding: 'utf8', windowsHide: true });
  check(calc.status === 0, 'economic calculator completes without DB');
  const economy = JSON.parse(readFileSync(join(directory, 'universe-acquisition-economy.json'),'utf8'));
  const packs = economy.rows.filter(r => r.variant === 'firstPack129');
  check(new Set(packs.map(r => r.firstPackVc)).size === 1, 'same first pack VC across all scenarios');
  check(economy.rows.every(r => r.promoAiRub > 0), 'promo cost no longer cancels itself');
  check(economy.rows.every(r => Math.abs(r.profit - (r.netRevenue - r.variableCost - r.infraAndAcquisition)) < 0.03), 'profit identities include all modeled costs');
  check(economy.rows.filter(r => r.variant === 'control').every(r => r.carryoverLiabilityRub === 0), 'no invented carryover of expiring subscription VC');
  const preciseEvent = await db.aiCostEvent.create({ data: { id: 'reconcile_fixture', operationId: 'reconcile_operation',
    provider: 'kodikrouter', model: 'test/model', purpose: 'chat', attempt: 1, outcome: 'completed',
    usageSource: 'provider', costSource: 'chat_usd_estimate', accountingVersion: 2, apiSurface: 'chat_completions',
    inputTokens: 100, outputTokens: 10, chargedVC: 4, quotedVC: 36, estimatedCostRub: 5,
    inputRubPerMillion: 10, outputRubPerMillion: 20, providerRequestId: 'kr_req_exact_fixture', providerResponseId: 'gen_exact_fixture' } });
  const ledgerPath = join(directory, 'ledger.json');
  writeFileSync(ledgerPath, JSON.stringify([{ id: 'ledger_fixture', api_key_name: 'fixture_key', status: 'success',
    timestamp: new Date().toISOString(), request_id: preciseEvent.providerResponseId, model_id: 'test/model', input_tokens: 100, output_tokens: 10, cost_rub: '0.006672' }]));
  const reconciledExport = spawnSync(process.execPath, ['scripts/report-ai-costs.mjs'], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, COST_REPORT_DATABASE_URL: url, KODIK_COST_EXPORT: ledgerPath, KODIK_COST_API_KEY_NAME: 'fixture_key' } });
  check(reconciledExport.status === 0 && JSON.parse(reconciledExport.stdout).totals.confirmedCostRubExact === '0.006672',
    'real read-only PostgreSQL report joins existing export by exact response ID');
  const csvLedgerPath = join(directory, 'ledger.csv');
  writeFileSync(csvLedgerPath, 'request_id;id;api_key_name;timestamp;model_id;status;input_tokens;output_tokens;cost_rub\r\n'
    + `${preciseEvent.providerResponseId};ledger_fixture;fixture_key;${new Date().toISOString().slice(0,-1)};test/model;success;100;10;0,006672\r\n`);
  const csvExport = spawnSync(process.execPath, ['scripts/report-ai-costs.mjs'], { encoding:'utf8',windowsHide:true,
    env:{...process.env,COST_REPORT_DATABASE_URL:url,KODIK_COST_EXPORT:csvLedgerPath,KODIK_COST_API_KEY_NAME:'fixture_key',KODIK_COST_EXPORT_TIMEZONE:'UTC'} });
  check(csvExport.status === 0 && JSON.parse(csvExport.stdout).totals.confirmedCostRubExact === '0.006672',
    'real PostgreSQL report directly reconciles decimal-comma CSV with verified UTC');
  const otherTimezoneExport = spawnSync(process.execPath, ['scripts/report-ai-costs.mjs'], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, TZ: 'Pacific/Honolulu', COST_REPORT_DATABASE_URL: url, KODIK_COST_EXPORT: ledgerPath,
      KODIK_COST_API_KEY_NAME: 'fixture_key', COST_REPORT_FROM: new Date(Date.now()-3600000).toISOString(),
      COST_REPORT_TO: new Date(Date.now()+3600000).toISOString() } });
  check(otherTimezoneExport.status === 0 && JSON.parse(otherTimezoneExport.stdout).totals.confirmedCostRubExact === '0.006672',
    'report date bounds stay UTC under a different process timezone');
  check((await db.aiCostEvent.findUnique({ where: { id: preciseEvent.id } })).estimatedCostRub === 5,
    'reconciliation never writes into event history');
  const snapshot = join(directory, 'cost-report.json');
  writeFileSync(snapshot, reconciledExport.stdout);
  const measuredCalc = spawnSync(process.execPath, calcArgs, { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ECONOMY_COST_REPORT: snapshot } });
  check(measuredCalc.status === 0, 'calculator accepts verified v2 report with covered paid usage');
  const measuredEconomy = JSON.parse(readFileSync(join(directory, 'universe-acquisition-economy.json'), 'utf8'));
  const medium = measuredEconomy.rows.find(row => row.variant === 'control' && row.scenario === 'medium');
  check(medium.paidRequests === 1_200_000, 'observed calculator uses actual four VC, not mixed catalog quotes');
  const expectedPromo = Math.round(200 * 30_000 * 0.04 * ((0.014 + 0.006672) / 8) * 1.08 * 1.15 * 100) / 100;
  check(medium.promoAiRub === expectedPromo && measuredEconomy.measurementSource.coverage.confirmedCost === 1,
    'medium uses reconciled costs and estimates once and keeps confirmation metadata');
  const incompleteReport = structuredClone(report);
  incompleteReport.models.filter(m => m.purpose === 'chat').forEach(m => { m.chargedProviderUsageCount = 0; });
  writeFileSync(snapshot, JSON.stringify(incompleteReport));
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
  if (process.platform === 'win32' && pg.process) {
    const child = pg.process;
    // Stop only the cluster created by this fixture. Await CLOSE, not just EXIT:
    // the embedded runtime's taskkill helper can retain stdio handles on Windows.
    assert.equal(resolve(child.spawnargs[child.spawnargs.indexOf('-D') + 1]), resolve(join(directory, 'db')));
    const closed = new Promise(done => child.once('close', done));
    const stopped = spawnSync(join(dirname(child.spawnfile), 'pg_ctl.exe'),
      ['stop', '-D', join(directory, 'db'), '-m', 'fast', '-w', '-t', '15'],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    if (stopped.status !== 0) throw new Error('Fixture PostgreSQL shutdown failed');
    await closed;
    pg.process = undefined;
  } else await pg.stop();
  console.log('Cost fixture cleanup: local HTTP server');
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  console.log('Cost fixture cleanup complete');
}
