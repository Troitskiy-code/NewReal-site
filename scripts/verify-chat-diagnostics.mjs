// Real telemetry/logger code with in-memory DB and deterministic fetch; no .env or network.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createModuleLoader } from './lib/memory-test-harness.mjs';

for (const key of Object.keys(process.env)) {
  if (/^(LOGTAIL_|AI_COST_|DEEPINFRA_|CHAT_AI_PROVIDER|MEMORY_AI_PROVIDER)/.test(key)) delete process.env[key];
}
const rows = new Map();
let failRefund = false;
const db = {
  model: { findUnique: async () => null },
  aiCostEvent: {
    create: async ({ data }) => { rows.set(data.id, { ...data }); return data; },
    update: async ({ where, data }) => { Object.assign(rows.get(where.id), data); return rows.get(where.id); },
  },
  user: { update: async () => ({}) },
  transaction: { create: async () => ({ id: 'local_refund_transaction' }), delete: async () => ({}) },
  $queryRaw: async () => [{ verseCoins: 100, permanentCoins: 100 }],
};
db.$transaction = async input => {
  if (typeof input === 'function') return input(db);
  await Promise.all(input);
  if (failRefund) throw Object.assign(new Error('private_refund_error'), { code: 'P2034' });
};
const { load, root } = createModuleLoader({ prismaFor: () => db });
const logger = load(join(root, 'src/lib/logger.ts'));
const telemetry = load(join(root, 'src/lib/aiCostTelemetry.ts'));
const helpers = load(join(root, 'src/lib/chatHelpers.ts'));
const diagnostics = load(join(root, 'src/lib/chatDiagnostics.ts'));
const consoleLines = [], sinkLines = [];
const originalConsole = { error: console.error, info: console.info, debug: console.debug, log: console.log };
const capture = (...args) => consoleLines.push(args.join(' '));
console.error = capture; console.info = capture; console.debug = capture; console.log = capture;
logger.setDiagnosticSink({ error: line => sinkLines.push(line), info: line => sinkLines.push(line), debug: line => sinkLines.push(line) });
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; originalConsole.log(`PASS ${label}`); };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const text = frame({ choices: [{ delta: { content: 'private_reply' } }] });
const terminal = frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
const endpoint = 'https://api.deepinfra.com/v1/openai/chat/completions';
const model = 'mistralai/Mistral-Small-3.2-24B-Instruct-2506';
const secretError = Object.assign(new Error('private_error_message Bearer private_api_key'), {
  stack: 'private_error_stack', config: { password: 'private_password' },
  cause: Object.assign(new Error('private_cause'), { code: 'ECONNRESET' }),
});
async function exercise(fetcher, signal, cancel = false) {
  globalThis.fetch = async (url, init) => { assert.equal(url, endpoint); return fetcher(init); };
  consoleLines.length = sinkLines.length = 0;
  await telemetry.withAiCostContext(async () => {
    telemetry.setAiCostActor('fixture_user', 'start');
    try {
      const response = await telemetry.meteredChatFetch(endpoint, { signal }, model, 100);
      if (cancel) { const reader = response.body.getReader(); await reader.read(); await reader.cancel(); reader.releaseLock(); }
      else await response.text();
    } catch { /* Expected simulated transport failures. */ }
  });
  const row = [...rows.values()].at(-1);
  const logs = consoleLines.filter(line => line.includes('[ChatDiagnostics]'));
  check(logs.length === (row.outcome === 'completed' ? 0 : 1), 'one final diagnostic per failed attempt; none for success');
  if (logs.length) {
    check(logs[0].includes(row.id) && logs[0].includes(row.operationId) && logs[0].includes('"audience":"user"')
      && logs[0].includes('"attempt":1'), 'diagnostic matches persisted cost event and operation');
    check(sinkLines.includes(logs[0]), 'console and log sink receive the same safe diagnostic');
  }
  check(!JSON.stringify([...consoleLines, ...sinkLines]).includes('private_'), 'private text, credentials and error bodies absent in both channels');
  return logs[0] ?? '';
}
try {
  let line = await exercise(() => new Response(text));
  check(line.includes('"protocolReason":"missing_done"') && line.includes('"hasText":true')
    && line.includes('"firstTextMs":') && line.includes('"bytesReceived":'), 'HTTP 200 truncated reply has completion flags and timings');
  line = await exercise(() => new Response(frame({ error: { message: 'private_provider_body' } })));
  check(line.includes('"protocolReason":"provider_error"') && line.includes('"stage":"awaiting_text"'), 'provider SSE error classified without copying its body');
  line = await exercise(() => new Response(terminal));
  check(line.includes('"protocolReason":"empty_text"') && line.includes('"firstTextMs":null'), 'empty successful HTTP response is distinguished from partial text');
  line = await exercise(() => new Response('private_http_body', { status: 429 }));
  check(line.includes('"reason":"http_error"') && line.includes('"status":429'), 'HTTP rejection keeps status, never its response body');
  line = await exercise(() => new Response(null, { status: 200 }));
  check(line.includes('"reason":"missing_body"'), 'missing response body diagnosed separately');
  line = await exercise(() => { throw secretError; });
  check(line.includes('"stage":"awaiting_headers"') && line.includes('"reason":"transport_error"')
    && line.includes('ECONNRESET'), 'fetch transport failure preserves safe cause code');
  for (const stage of ['first_byte', 'idle', 'total']) {
    const controller = new AbortController();
    const fetcher = stage === 'first_byte' ? () => {
      controller.abort(new helpers.ChatStreamTimeoutError(stage)); throw secretError;
    } : () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); }, pull(c) {
      controller.abort(new helpers.ChatStreamTimeoutError(stage)); c.error(secretError);
    } }));
    line = await exercise(fetcher, controller.signal);
    check(line.includes('"reason":"timeout"') && line.includes(`"timeoutStage":"${stage}"`), `${stage}: exact watchdog timeout stage`);
  }
  line = await exercise(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); } })), undefined, true);
  check(line.includes('"outcome":"cancelled"') && line.includes('"reason":"consumer_cancelled"'), 'consumer cancellation differs from provider error');
  await exercise(() => new Response(text + terminal));
  const hostile = new Proxy({}, { get() { throw secretError; } });
  check(diagnostics.chatTransportDiagnostic(hostile).fields.reason === 'transport_error', 'hostile caught error cannot interrupt diagnostics');
  for (const failure of [false, true]) {
    failRefund = failure;
    consoleLines.length = sinkLines.length = 0;
    await telemetry.withAiCostContext(async () => {
      const context = telemetry.aiCostDiagnosticContext();
      const charge = await helpers.reserveChatCharge({ userId: 'fixture_user', costVC: 4,
        characterName: 'private_character', modelDisplayName: 'private_model_display' });
      await charge.refund(); await charge.refund();
      const logs = consoleLines.filter(value => value.includes('[ChatRefund]'));
      check(logs.length === 1 && logs[0].includes(context.operationId)
        && logs[0].includes(`"refundStatus":"${failure ? 'failed' : 'completed'}"`)
        && logs[0].includes('"costVC":4') && logs[0].includes('local_refund_transaction'),
      `${failure ? 'failed' : 'completed'} refund: one correlated diagnostic without declaring failure a success`);
      check(sinkLines.includes(logs[0]) && !JSON.stringify(sinkLines).includes('private_'), 'refund diagnostics safe in console and sink');
    });
  }
  logger.setDiagnosticSink({ error() { throw secretError; }, info() {}, debug() {} });
  globalThis.fetch = async () => new Response(text);
  const response = await telemetry.meteredChatFetch(endpoint, {}, model, 100);
  await response.text();
  check([...rows.values()].at(-1).outcome === 'failed', 'broken log sink does not change stream accounting or termination');
} finally {
  Object.assign(console, originalConsole);
  logger.setDiagnosticSink(null);
}
console.log(`Chat diagnostics verification: ${checks} passed; no live DB or AI calls.`);
