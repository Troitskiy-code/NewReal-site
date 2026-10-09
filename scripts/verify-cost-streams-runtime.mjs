// Real chat/regenerate handlers + disposable PostgreSQL/PGlite, fake AI only.
// Never loads .env; the shared harness blocks all external provider requests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startHarness } from './lib/memory-test-harness.mjs';
import { buildAiCostReport } from './lib/ai-cost-report.mjs';

const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const h = await startHarness({ label: 'cost-streams' });
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log(`PASS ${label}`); };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const part = frame({ id: 'gen_stream_fixture', model: 'google/gemma-4-31b-it', choices: [{ delta: { content: 'Частичный ответ 🌌' } }] });
const finish = reason => frame({ choices: [{ delta: {}, finish_reason: reason }] });
const usage = frame({ usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 } });
const done = 'data: [DONE]\n\n';
const error = frame({ error: { message: 'secret_provider_response', code: 'provider_error' } });
let payload = part + finish('stop') + usage + done;
let transportError = false, waiting = false;
const originalFakeFetch = h.provider.fetch.bind(h.provider);
let providerCancelled = false;
h.provider.fetch = async (url, init) => {
  const original = await originalFakeFetch(url, init);
  await original.body.cancel();
  let sent = false;
  return new Response(new ReadableStream({
    pull(c) {
      if (!sent) { c.enqueue(new TextEncoder().encode(payload)); sent = true; return; }
      if (waiting) return;
      if (transportError) c.error(new Error('synthetic_transport_failure'));
      else c.close();
    },
    cancel() { providerCancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream', 'x-kodikrouter-request-id': 'kr_req_stream_fixture' } });
};

async function post(userId, characterId, body, regenerate = false) {
  h.session.userId = userId;
  const file = regenerate ? 'src/app/api/chat/[id]/regenerate/route.ts' : 'src/app/api/chat/[id]/route.ts';
  const route = h.load(join(h.root, file));
  const response = await route.POST(new NextRequest(`http://localhost/api/chat/${characterId}${regenerate ? '/regenerate' : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: characterId }) });
  const wire = await response.text();
  await h.settle();
  return { response, wire };
}

try {
  process.env['AI_COST_USD_RUB'] = '90';
  await h.helpers.model();
  const cases = [
    ['provider SSE error', part + usage + error],
    ['error followed by stop/DONE', part + usage + error + finish('stop') + done],
    ['unexpected EOF', part + usage],
    ['missing DONE', part + usage + finish('stop')],
    ['missing finish_reason', part + usage + done],
    ['native cost without token usage', part + frame({ usage: { cost: 0.02 } }) + error],
    ['transport failure', part + usage],
  ];
  let nativeOnly;
  for (const [label, fixture] of cases) {
    const user = await h.helpers.user('start'), character = await h.helpers.character(user.id);
    payload = fixture; transportError = label === 'transport failure';
    const requests = h.provider.chatRequests.length;
    const { response, wire } = await post(user.id, character.id, { message: 'Я продолжаю рассказ о маяке.' });
    check(response.status === 200 && wire.includes('"type":"error"') && !wire.includes('"type":"end"')
      && !wire.includes('secret_provider_response'), `${label}: real chat returns safe streaming error`);
    check((await h.db.user.findUnique({ where: { id: user.id } })).verseCoins === user.verseCoins
      && await h.db.transaction.count({ where: { userId: user.id, type: 'chat' } }) === 0
      && await h.db.message.count({ where: { userId: user.id, characterId: character.id, role: 'assistant' } }) === 0,
      `${label}: wallet, charge transaction and assistant message remain untouched`);
    check(h.provider.chatRequests.length === requests + 1, `${label}: no automatic paid retry`);
    const cost = await h.db.aiCostEvent.findFirst({ where: { actorHash: { not: null }, purpose: 'chat', operationId: {
      in: (await h.db.aiCostEvent.findMany({ where: { purpose: 'chat' }, orderBy: { createdAt: 'desc' }, take: 1 })).map(row => row.operationId),
    } } });
    check(cost?.outcome === 'failed' && cost.chargedVC === 0 && cost.providerCostNative > 0
      && cost.estimatedCostRub > 0 && cost.providerRequestId === 'kr_req_stream_fixture'
      && cost.providerResponseId === 'gen_stream_fixture', `${label}: failed cost retains known usage/native cost and both IDs`);
    const accounting = buildAiCostReport([cost]);
    check(accounting.coverage.estimatedCost === 1 && accounting.totals.estimatedCostRub > 0
      && accounting.models[0].chargedCompleted === 0, `${label}: expense survives report without successful paid reply`);
    if (label === 'native cost without token usage') nativeOnly = cost;
    const telemetry = h.load(join(h.root, 'src/lib/aiCostTelemetry.ts'));
    // A caller cannot mark an unsuccessful stream as charged in telemetry either.
    const rejected = await telemetry.meteredChatFetch('https://api.kodikrouter.ru/v1/chat/completions', {
      body: JSON.stringify({ model: 'google/gemma-4-31b-it' }),
    }, 'google/gemma-4-31b-it', 100);
    await rejected.text().catch(() => {});
    await telemetry.recordChatCostCharge(rejected.body, 4);
    check(await h.db.aiCostEvent.count({ where: { purpose: 'chat', outcome: 'failed', chargedVC: { gt: 0 } } }) === 0,
      `${label}: accounting refuses a false charge annotation`);
  }
  transportError = false;
  for (const reason of ['stop', 'length']) {
    payload = part + finish(reason) + usage + done;
    const user = await h.helpers.user('start'), character = await h.helpers.character(user.id);
    const { wire } = await post(user.id, character.id, { message: 'Я продолжаю исследовать маяк.' });
    check(wire.includes('"type":"end"') && (await h.db.user.findUnique({ where: { id: user.id } })).verseCoins === user.verseCoins - 4
      && await h.db.transaction.count({ where: { userId: user.id, type: 'chat' } }) === 1, `${reason}: real successful reply charges once`);
  }
  const user = await h.helpers.user('start'), character = await h.helpers.character(user.id);
  await h.helpers.messages(user.id, character.id, [{ role: 'user', content: 'Расскажи о маяке.' },
    { role: 'assistant', content: 'Старый маяк стоит на берегу' }], { embed: false });
  const answer = await h.db.message.findFirst({ where: { userId: user.id, characterId: character.id, role: 'assistant' } });
  payload = part + usage + error;
  for (const regenerate of [false, true]) {
    const { wire } = await post(user.id, character.id, regenerate ? { messageId: answer.id } : { continue: true }, regenerate);
    check(wire.includes('"type":"error"') && !wire.includes('"type":"end"')
      && (await h.db.user.findUnique({ where: { id: user.id } })).verseCoins === user.verseCoins
      && (await h.db.message.findUnique({ where: { id: answer.id } })).content === answer.content
      && await h.db.transaction.count({ where: { userId: user.id, type: 'chat' } }) === 0,
      `${regenerate ? 'regenerate' : 'continue'}: failed reply preserves previous answer and VC`);
  }
  waiting = true; payload = part + usage;
  const telemetry = h.load(join(h.root, 'src/lib/aiCostTelemetry.ts'));
  const cancelled = await telemetry.meteredChatFetch('https://api.kodikrouter.ru/v1/chat/completions', {
    body: JSON.stringify({ model: 'google/gemma-4-31b-it' }),
  }, 'google/gemma-4-31b-it', 100);
  const reader = cancelled.body.getReader(); await reader.read(); await reader.cancel(); reader.releaseLock();
  const cancelledCost = await h.db.aiCostEvent.findFirst({ where: { purpose: 'chat', outcome: 'cancelled' } });
  check(providerCancelled && cancelledCost?.chargedVC === 0 && cancelledCost.providerCostNative === 0.01
    && cancelledCost.inputTokens === 100 && cancelledCost.outputTokens === 10, 'explicit cancellation retains known cost and tokens');
  await h.db.aiCostEvent.createMany({ data: [6.825000000000001e-6, 0.0004738499999999999].map((estimatedCostRub, index) => ({
    id: `float_estimate_fixture_${index}`, operationId: 'float_estimate_fixture', provider: 'kodikrouter',
    model: 'test/float-estimate', purpose: 'embedding', attempt: index + 1, outcome: 'completed',
    usageSource: 'provider', costSource: 'catalog_estimate', accountingVersion: 2, apiSurface: 'embeddings',
    inputTokens: index === 0 ? 3 : 243, outputTokens: 0, estimatedCostRub,
  })) });
  const exported = spawnSync(process.execPath, ['scripts/report-ai-costs.mjs'], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, COST_REPORT_DATABASE_URL: h.databaseUrl } });
  assert.equal(exported.status, 0, exported.stderr);
  const all = JSON.parse(exported.stdout), direct = buildAiCostReport(await h.db.aiCostEvent.findMany());
  const floatGroup = all.models.find(row => row.model === 'test/float-estimate');
  check(floatGroup.estimatedCostCount === 2 && floatGroup.unknownCostCount === 0
    && floatGroup.estimatedCostRubExact === '0.000480675', 'real PostgreSQL Float estimates survive the read-only report');
  check(all.totals.estimatedCostRubExact === direct.totals.estimatedCostRubExact && nativeOnly?.estimatedCostRub === 1.8,
    'real read-only SQL report retains failed cost-only usage as well as measured tokens');
  check(!JSON.stringify(await h.db.aiCostEvent.findMany()).includes('secret_provider_response'), 'provider error body never persisted');
  console.log(`Cost stream runtime verification: ${checks} passed`);
} finally { await h.stop(); }
