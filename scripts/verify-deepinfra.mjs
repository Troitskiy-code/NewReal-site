// Actual handlers + disposable PostgreSQL/PGlite. No .env or paid requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { startHarness } from './lib/memory-test-harness.mjs';
import { buildAiCostReport } from './lib/ai-cost-report.mjs';

const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const h = await startHarness({ label: 'deepinfra' });
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log(`PASS ${label}`); };
const load = file => h.load(join(h.root, file));
const routes = [], posts = [];
const originalPost = h.provider.axiosPost.bind(h.provider);
const originalFetch = h.provider.fetch.bind(h.provider);
const axios = require('axios');
axios.post = async (url, body, config) => {
  posts.push({ url, body, config });
  if (!['https://api.deepinfra.com/v1/openai/chat/completions', 'https://api.deepinfra.com/v1/openai/embeddings', 'https://api.kodikrouter.ru/v1/chat/completions', 'https://api.kodikrouter.ru/v1/embeddings'].includes(url)) throw new Error('External request blocked');
  const result = await originalPost(url, body);
  if (url.includes('deepinfra.com')) {
    result.headers = { 'x-request-id': 'di_request_fixture' };
    result.data.id = 'chatcmpl_di_fixture';
    result.data.model = body.model;
    result.data.usage = { prompt_tokens: 100, completion_tokens: 10, estimated_cost: 0.002, cost: 98765 };
  }
  return result;
};
let mode = 'success', rejects = 0;
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
globalThis.fetch = async (url, init) => {
  if (!['https://api.deepinfra.com/v1/openai/chat/completions', 'https://api.kodikrouter.ru/v1/chat/completions'].includes(url)) throw new Error('External fetch blocked');
  const body = JSON.parse(init.body);
  routes.push({ url, body, headers: init.headers, signal: init.signal, redirect: init.redirect });
  if (mode === 'reject' || (mode === 'retry' && rejects++ === 0)) return new Response('synthetic_secret_provider_body', { status: mode === 'reject' ? 401 : 429 });
  // Reuse the harness's synthetic response builder, never its network path.
  const result = await originalFetch('https://api.kodikrouter.ru/v1/chat/completions', init);
  await result.body.cancel();
  const usage = frame({ id: 'chatcmpl_di_fixture', usage: { prompt_tokens: 100, completion_tokens: 10,
    completion_tokens_details: { reasoning_tokens: 3 }, estimated_cost: 0.002, cost: 98765 } });
  const content = frame({ id: 'chatcmpl_di_fixture', model: body.model, choices: [{ delta: { content: h.provider.reply } }] });
  const ending = frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + usage + 'data: [DONE]\n\n';
  if (mode === 'stall') return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content + usage));
      init.signal.addEventListener('abort', () => controller.error(new DOMException('Synthetic timeout', 'AbortError')), { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  return new Response(content + (mode === 'broken' ? usage + frame({ error: { message: 'synthetic_secret_provider_body' } }) : ending),
    { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'di_request_fixture' } });
};
async function postRoute(file, userId, characterId, body) {
  h.session.userId = userId;
  const r = load(file);
  const response = await r.POST(new NextRequest('http://localhost/api/test', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: characterId }) });
  const wire = await response.text();
  await h.settle();
  return { response, wire };
}
try {
  const provider = load('src/lib/aiProviders.ts');
  const models = load('src/lib/deepinfraModels.ts');
  const telemetry = load('src/lib/aiCostTelemetry.ts');
  const helpers = load('src/lib/chatHelpers.ts');
  const client = load('src/lib/aiTextClient.ts');
  const policy = load('src/lib/testingChatModels.ts');
  const legacy = await h.helpers.model(20000);
  const user = await h.helpers.user('universe');
  await h.db.user.update({ where: { id: user.id }, data: { selectedModelId: legacy.id } });
  const character = await h.helpers.character(user.id);
  const sql = readFileSync(join(h.root, 'prisma/migrations/20261011210000_deepinfra_chat_catalog/migration.sql'), 'utf8');
  const { Client } = require('pg');
  const pg = new Client({ connectionString: h.databaseUrl });
  await pg.connect();
  try { await pg.query('BEGIN'); await pg.query(sql); await pg.query('COMMIT'); } finally { await pg.end(); }
  check(await h.db.model.count({ where: { name: { startsWith: 'deepinfra:' } } }) === 11, 'exact SQL adds the eleven agreed models; GLM is not added');
  const ids = (await h.db.model.findMany({ where: { name: { startsWith: 'deepinfra:' } }, orderBy: { name: 'asc' } })).map(m => m.id);
  const pg2 = new Client({ connectionString: h.databaseUrl });
  await pg2.connect();
  try { await pg2.query('BEGIN'); await pg2.query(sql); await pg2.query('COMMIT'); } finally { await pg2.end(); }
  check(JSON.stringify(ids) === JSON.stringify((await h.db.model.findMany({ where: { name: { startsWith: 'deepinfra:' } }, orderBy: { name: 'asc' } })).map(m => m.id)), 'catalogue replay preserves every model ID');
  check((await h.db.model.findUnique({ where: { id: legacy.id } })).priceVC === legacy.priceVC
    && (await h.db.user.findUnique({ where: { id: user.id } })).selectedModelId === legacy.id, 'SQL preserves legacy models and user choices');
  check(provider.getChatProvider() === 'kodikrouter' && provider.getMemoryProvider() === 'kodikrouter', 'default rollout preserves both Kodik routes');
  h.session.userId = user.id;
  const modelsRoute = load('src/app/api/models/route.ts');
  const before = await (await modelsRoute.GET()).json();
  check(before.models.length === 1 && before.models[0].name === legacy.name, 'new catalogue stays hidden before the chat switch');
  process.env['CHAT_AI_PROVIDER'] = 'deepinfra';
  process.env['MEMORY_AI_PROVIDER'] = 'deepinfra';
  process.env['DEEPINFRA_USD_RUB'] = '108.192';
  check(!provider.chatProviderConfigured(), 'missing DeepInfra key does not silently use Kodik');
  const countBefore = routes.length;
  const missing = await postRoute('src/app/api/chat/[id]/route.ts', user.id, character.id, { message: 'Сообщение без ключа.' });
  check(missing.response.status === 500 && routes.length === countBefore
    && (await h.db.user.findUnique({ where: { id: user.id } })).verseCoins === user.verseCoins, 'missing key fails before charge or upstream');
  process.env['DEEPINFRA_API_KEY'] = 'synthetic_deepinfra_key';
  const list = await (await modelsRoute.GET()).json();
  check(list.models.length === 9 && list.baseModelId === ids.find(id => id === 'di_chat_20261011_01'), 'switched API exposes nine models and the Mistral default');
  check(models.DISABLED_DEEPINFRA_MODEL_NAMES.every(name => !list.models.some(m => m.name === name)), 'models that produced no tokens in 60 s stay hidden');
  check(list.selectedModelId === null && list.models.filter(m => m.isTesting).length === 2, 'old selection is safely ignored; only DeepSeek V4 and MiMo are testing');
  for (const item of models.DEEPINFRA_CHAT_MODELS.filter(m => !models.DISABLED_DEEPINFRA_MODEL_NAMES.includes(m.name))) {
    const row = list.models.find(m => m.name === item.name);
    check(row?.priceVC === item.priceVC && row.maxContextTokens === 20000, `${item.displayName}: agreed price and full product context`);
  }
  const select = load('src/app/api/user/select-model/route.ts');
  const request = id => new NextRequest('http://localhost/api/user/select-model', { method: 'POST', body: JSON.stringify({ modelId: id }) });
  check((await select.POST(request(legacy.id))).status === 400, 'selection API cannot choose an inactive provider');
  const middle = list.models.find(m => m.name === 'deepinfra:NousResearch/Hermes-3-Llama-3.1-70B');
  check((await select.POST(request(middle.id))).status === 200, 'new 24 VC middle-tier model is selectable');
  const reply = await h.chat(user.id, character.id, { message: 'Я открываю дверь маяка и продолжаю нашу историю.' });
  check(reply.status === 200 && reply.events.some(e => e.type === 'end'), 'real chat handler completes a DeepInfra reply');
  const wireCall = routes.at(-1);
  check(wireCall.url === 'https://api.deepinfra.com/v1/openai/chat/completions'
    && wireCall.body.model === 'NousResearch/Hermes-3-Llama-3.1-70B'
    && wireCall.headers.Authorization === 'Bearer synthetic_deepinfra_key', 'request uses exact API ID and exclusively the DeepInfra key');
  check(wireCall.body.max_tokens === 1000 && wireCall.body.stream_options.include_usage === true
    && wireCall.redirect === 'error', 'stream requests usage, caps total output, and refuses authenticated redirects');
  check((await h.db.user.findUnique({ where: { id: user.id } })).verseCoins === user.verseCoins - 24
    && await h.db.transaction.count({ where: { userId: user.id, type: 'chat' } }) === 1, 'successful reply deducts 24 VC exactly once');
  const cost = await h.db.aiCostEvent.findFirst({ where: { provider: 'deepinfra', purpose: 'chat', chargedVC: 24 } });
  check(cost?.providerCostNative === 0.002 && cost.providerCostCurrency === 'USD'
    && cost.providerCostSemantics === 'provider_estimated_usd' && cost.outputTokens === 10, 'estimated_cost is USD; cost is ignored; reasoning is not added twice');
  check(Math.abs(cost.estimatedCostRub - 0.216384) < 1e-12 && cost.usdRub === 108.192 && cost.reportedCostRub === null, 'cost uses funded-dollar FX and remains an estimate');
  check(cost.providerRequestId === 'di_request_fixture' && cost.providerResponseId === 'chatcmpl_di_fixture', 'both available provider IDs are recorded');
  check(buildAiCostReport([cost]).coverage.estimatedCost === 1, 'accounting report recognises the new provider estimate');
  const previousReply = await h.db.message.findFirst({ where: { userId: user.id, characterId: character.id, role: 'assistant' } });
  const regenerated = await postRoute('src/app/api/chat/[id]/regenerate/route.ts', user.id, character.id, { messageId: previousReply.id });
  check(regenerated.wire.includes('"type":"end"')
    && (await h.db.user.findUnique({ where: { id: user.id } })).verseCoins === user.verseCoins - 48,
    'actual regenerate handler uses the selected DeepInfra model and charges once');
  const guest = load('src/lib/anonymousChat.ts');
  h.session.userId = null;
  const guestResponse = await telemetry.withAiCostContext(() => guest.handleAnonymousChatPost(new NextRequest('http://localhost/api/chat/guest', {
    method: 'POST', headers: { 'x-forwarded-for': '127.0.0.2' },
  }), character.id, { message: 'Я прихожу к маяку впервые.', requestId: randomUUID() }));
  const guestWire = await guestResponse.text();
  await h.settle();
  check(guestResponse.status === 200 && guestWire.includes('"type":"end"')
    && routes.at(-1).body.model === models.DEEPINFRA_CHAT_MODELS[0].apiModel,
    'guest generation uses the inexpensive DeepInfra default');
  check(await h.db.aiCostEvent.count({ where: { provider: 'deepinfra', audience: 'guest', chargedVC: 0, outcome: 'completed' } }) === 1,
    'guest costs are tracked without a user VC deduction');
  const tasks = ['summary', 'intent', 'memory', 'character_event', 'character_prompt'];
  for (const purpose of tasks) {
    await client.serviceChatPost(purpose, 'https://api.kodikrouter.ru/v1/chat/completions',
      { model: purpose === 'memory' ? 'google/gemma-4-31b-it' : 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'synthetic_service_prompt' }], max_tokens: 80, temperature: 0.2, reasoning: { effort: 'high' }, service_tier: 'priority' },
      { headers: { Authorization: 'Bearer synthetic_memory_key' }, timeout: 5000 });
    const request = posts.at(-1);
    check(request.url.includes('deepinfra.com') && request.config.headers.Authorization === 'Bearer synthetic_deepinfra_key'
      && request.body.max_tokens === 80 && request.body.service_tier === undefined && request.body.reasoning === undefined,
      `${purpose}: service routing replaces credentials and strips costly legacy options while retaining its cap`);
  }
  check(posts.at(-1).body.model === 'Qwen/Qwen3-235B-A22B-Instruct-2507', 'AI character prompts use Qwen Instruct');
  await client.serviceChatPost('summary', 'https://api.kodikrouter.ru/v1/chat/completions',
    { model: 'openai/gpt-4o-mini', messages: [], max_tokens: 1500 });
  check(posts.at(-1).body.max_tokens === 1500, 'Universe summary keeps its original 1500-token output allowance');
  check(provider.serviceTransport('memory', 'google/gemma-4-31b-it').model === 'google/gemma-4-31B-it-turbo'
    && provider.serviceTransport('memory', 'openai/gpt-4o-mini').model.startsWith('mistralai/'), 'core memory uses Gemma; episodic classifier uses Mistral');
  const embeddings = load('src/lib/memoryEmbeddings.ts');
  const vectors = await embeddings.fetchEmbeddings(['Факт для сравнения'], 'synthetic_memory_key');
  check(vectors[0].length === 1024 && posts.at(-1).url === 'https://api.deepinfra.com/v1/openai/embeddings'
    && posts.at(-1).body.model === 'Qwen/Qwen3-Embedding-0.6B', 'embeddings follow the DeepInfra memory provider in an isolated vector space');
  const backfill = load('src/lib/embeddingBackfill.ts');
  await h.helpers.messages(user.id, character.id, [{ role: 'user', content: 'UNINDEXED_BACKFILL_FIXTURE' }], { embed: false });
  const backlog = await backfill.embeddingBackfillStatus();
  check(backlog.provider === 'deepinfra' && Number.isSafeInteger(backlog.remaining) && backlog.remaining > 0,
    'native PostgreSQL Prisma relation filter reads the eligible embedding backlog');
  const beforeBackfill = posts.length;
  const batch = await backfill.backfillDeepinfraEmbeddings();
  check(!batch.busy && !batch.failed && batch.saved > 0 && batch.attempted <= 10
    && posts.slice(beforeBackfill).every(p => p.url === 'https://api.deepinfra.com/v1/openai/embeddings'),
    'native PostgreSQL lease and eligible Prisma batch call only DeepInfra, with a ten-message cap');
  process.env['EMBEDDING_AI_PROVIDER'] = 'kodikrouter';
  const legacyVectors = await embeddings.fetchEmbeddings(['Факт для сравнения'], 'synthetic_memory_key');
  check(legacyVectors[0].length === 1536 && posts.at(-1).url === 'https://api.kodikrouter.ru/v1/embeddings'
    && posts.at(-1).body.model === 'openai/text-embedding-3-small'
    && posts.at(-1).config.headers.Authorization === 'Bearer synthetic_memory_key', 'explicit rollback retains provider, key, model and 1536 dimensions');
  delete process.env['EMBEDDING_AI_PROVIDER'];
  process.env['MEMORY_AI_PROVIDER'] = 'kodikrouter';
  await client.serviceChatPost('intent', 'https://api.kodikrouter.ru/v1/chat/completions', { model: 'google/gemma-4-31b-it', messages: [] }, { headers: { Authorization: 'Bearer synthetic_memory_key' } });
  check(posts.at(-1).url.includes('kodikrouter.ru') && provider.getChatProvider() === 'deepinfra', 'memory rollback is independent of chat');
  delete process.env['DEEPINFRA_USD_RUB'];
  await helpers.callChatCompletion(middle.name, [{ role: 'user', content: 'Проверка курса.' }], 'synthetic_memory_key');
  const noFx = await h.db.aiCostEvent.findFirst({ where: { provider: 'deepinfra', usdRub: null }, orderBy: { createdAt: 'desc' } });
  check(noFx?.providerCostNative === 0.002 && noFx.estimatedCostRub === null && noFx.costSource === 'unknown', 'missing funded-dollar FX does not borrow CBR or Kodik FX');
  process.env['DEEPINFRA_USD_RUB'] = '108.192';
  process.env['CHAT_AI_PROVIDER'] = 'kodikrouter';
  const restored = await (await modelsRoute.GET()).json();
  check(restored.models.length === 1 && restored.models[0].id === legacy.id, 'chat rollback restores the unchanged old catalogue');
  check((await helpers.resolveChatContext(user.id)).model.id === legacy.id, 'foreign provider selection cannot leak across rollback');
  process.env['CHAT_AI_PROVIDER'] = 'deepinfra';
  for (const failure of ['reject', 'broken']) {
    mode = failure;
    const u = await h.helpers.user('start'), c = await h.helpers.character(u.id);
    const attempts = routes.length;
    const result = await postRoute('src/app/api/chat/[id]/route.ts', u.id, c.id, { message: 'Обычная тестовая реплика.' });
    check(!result.wire.includes('synthetic_secret_provider_body'), `${failure}: raw provider errors never reach the client`);
    check((await h.db.user.findUnique({ where: { id: u.id } })).verseCoins === u.verseCoins
      && await h.db.transaction.count({ where: { userId: u.id, type: 'chat' } }) === 0, `${failure}: unsuccessful reply refunds VC`);
    check(routes.length === attempts + 1, `${failure}: no retry of rejected or partially generated response`);
  }
  const partial = await h.db.aiCostEvent.findFirst({ where: { provider: 'deepinfra', outcome: 'failed', providerCostNative: 0.002 }, orderBy: { createdAt: 'desc' } });
  check(buildAiCostReport([partial]).coverage.estimatedCost === 1 && partial.chargedVC === 0, 'paid partial work survives reporting without being a successful VC sale');
  mode = 'retry'; rejects = 0;
  const u = await h.helpers.user('start'), c = await h.helpers.character(u.id);
  const attempts = routes.length;
  const success = await postRoute('src/app/api/chat/[id]/route.ts', u.id, c.id, { message: 'Повтор только до начала потока.' });
  check(success.wire.includes('"type":"end"') && routes.length === attempts + 2
    && (await h.db.user.findUnique({ where: { id: u.id } })).verseCoins === u.verseCoins - 4, '429 before streaming permits a retry and one final charge');
  for (const model of models.DEEPINFRA_CHAT_MODELS.filter(m => m.reasoning)) {
    check(policy.chatModelGenerationOptions(model.name).reasoning_effort === 'none', `${model.displayName}: requested non-thinking mode and fixed total cap`);
  }
  mode = 'stall';
  const normalTimeout = policy.chatModelRequestTimeoutMs;
  policy.chatModelRequestTimeoutMs = () => 100;
  const stalledUser = await h.helpers.user('start'), stalledCharacter = await h.helpers.character(stalledUser.id);
  const beforeStall = routes.length;
  try {
    const stalled = await postRoute('src/app/api/chat/[id]/route.ts', stalledUser.id, stalledCharacter.id, { message: 'Оборванное соединение.' });
    check(stalled.wire.includes('"type":"error"') && !stalled.wire.includes('"type":"end"')
      && routes.length === beforeStall + 1 && (await h.db.user.findUnique({ where: { id: stalledUser.id } })).verseCoins === stalledUser.verseCoins,
      'timeout remains active after headers: stalled partial stream terminates, refunds, and never retries');
  } finally { policy.chatModelRequestTimeoutMs = normalTimeout; }
  process.env['CHAT_AI_PROVIDER'] = 'invalid';
  assert.throws(() => provider.getChatProvider());
  check(true, 'invalid provider configuration fails closed');
  console.log(`DeepInfra verification: ${checks} checks passed; no live provider calls.`);
} finally { await h.stop(); }
