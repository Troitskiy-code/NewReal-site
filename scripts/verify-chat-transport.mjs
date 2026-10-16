// Real application transport and consumer; all external requests are replaced with fixtures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createChatDiagnosticRuntime } from './lib/chat-diagnostic-runtime.mjs';
import { probeDirectStream, probePipelineStream } from './lib/chat-stream-probe.mjs';

for (const key of ['LOGTAIL_SOURCE_TOKEN', 'LOGTAIL_INGESTING_HOST']) delete process.env[key];
process.env.CHAT_AI_PROVIDER = 'deepinfra'; process.env.CHAT_TRANSPORT_TRACE = '1';
process.env.DEEPINFRA_API_KEY = 'private_probe_key';
const runtime = createChatDiagnosticRuntime();
const axios = createRequire(import.meta.url)('axios');
const modelName = 'deepinfra:google/gemma-4-31B-it-turbo';
const apiModel = modelName.slice('deepinfra:'.length);
const messages = [{ role: 'user', content: 'private_probe_prompt' }];
const body = { model: apiModel, messages, ...runtime.policy.chatModelGenerationOptions(modelName), stream: true, stream_options: { include_usage: true } };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const text = frame({ id: 'chatcmpl_probe', choices: [{ delta: { content: 'private_probe_reply' } }] });
const terminal = frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + frame({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } }) + 'data: [DONE]\n\n';
const nativeFetch = globalThis.fetch, consoleBackup = { ...console };
const logs = [], audit = [], requests = [];
for (const method of ['log', 'info', 'error', 'warn']) console[method] = (...args) => { const line = args.join(' '); logs.push(line); audit.push(line); };
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; consoleBackup.log(`PASS ${label}`); }
function fakeStream(delay = 0, suffix = terminal) {
  return (_url, init) => {
    requests.push(JSON.parse(init.body));
    let timer, target;
    const onAbort = () => { clearTimeout(timer); target.error(init.signal.reason); };
    return new Response(new ReadableStream({
      start(c) {
        target = c; c.enqueue(new TextEncoder().encode(text));
        init.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { init.signal.removeEventListener('abort', onAbort); c.enqueue(new TextEncoder().encode(suffix)); c.close(); }, delay);
      },
      cancel() { clearTimeout(timer); init.signal.removeEventListener('abort', onAbort); },
    }), { headers: { 'content-type': 'text/event-stream', 'x-deepinfra-request-id': 'provider_probe_123', 'content-encoding': 'gzip' } });
  };
}
try {
  const headers = runtime.diagnostics.safeTransportHeaders(new Headers({ 'retry-after': '2', 'x-deepinfra-request-id': 'provider_probe_123',
    'authorization': 'Bearer private_probe_key', 'set-cookie': 'private_probe_cookie', 'content-type': 'text/event-stream; charset=utf-8' }), 'deepinfra');
  check(headers.retryAfterMs === 2000 && headers.providerRequestId === 'provider_probe_123' && headers.responseContentType === 'text/event-stream', 'only normalized headers and provider ID retained');
  check(runtime.diagnostics.safeTransportHeaders(new Headers({ 'retry-after': 'private_probe_data', 'x-request-id': 'sk-private_probe_key', 'content-type': 'private_probe_data' }), 'deepinfra').providerRequestId === null, 'credential-like request IDs rejected');
  const dateHeaders = runtime.diagnostics.safeTransportHeaders(new Headers({ 'retry-after': new Date(Date.now() + 60000).toUTCString() }), 'deepinfra');
  check(dateHeaders.retryAfterMs > 58000 && dateHeaders.retryAfterMs <= 60000, 'Retry-After HTTP date converted to bounded milliseconds');
  const a = runtime.diagnostics.beginAiTransport('deepinfra', apiModel, 'chat');
  const b = runtime.diagnostics.beginAiTransport('deepinfra', apiModel, 'summary');
  check(b.fields().activeModelAtStart === 2 && a.fields().activeProviderNow === 2, 'service and chat calls counted together per model/provider');
  a.release(); a.release(); b.release();
  check(b.fields().activeModelNow === 0 && b.fields().activeProviderNow === 0, 'release is idempotent and removes completed requests');

  let direct = await probeDirectStream({ body, key: 'private_probe_key', runtime, fetcher: fakeStream(5), emit: value => logs.push(JSON.stringify(value)) });
  check(direct.outcome === 'completed' && direct.hasDone && direct.finishReason === 'stop' && direct.inputTokens === 20, 'direct probe reads usage, finish and DONE through EOF');
  globalThis.fetch = fakeStream(5);
  let pipeline = await probePipelineStream({ messages, modelName, key: 'private_probe_key', runtime });
  check(pipeline.outcome === 'completed' && pipeline.attempts.length === 1, 'pipeline uses real helpers/consumer and in-memory cost accounting');
  check(JSON.stringify(requests[0]) === JSON.stringify(requests[1]), 'direct and pipeline send identical model, options and messages');
  check(logs.some(line => line.includes('attempt ended') && line.includes('"outcome":"completed"') && line.includes('provider_probe_123')), 'opt-in success summary correlates timings with provider ID');
  check(logs.some(line => line.includes('attempt ended') && line.includes('"hasDone":true') && line.includes('"protocolReason":null')
    && !line.includes('"truncated":true')), 'full trace summary preserves completion flags within logger size limit');
  const limits = runtime.policy.chatModelStreamTimeouts;
  runtime.policy.chatModelStreamTimeouts = () => ({ firstByteMs: 200, idleMs: 20, totalMs: 300 });
  direct = await probeDirectStream({ body, key: 'private_probe_key', runtime, fetcher: fakeStream(55) });
  globalThis.fetch = fakeStream(55);
  pipeline = await probePipelineStream({ messages, modelName, key: 'private_probe_key', runtime });
  check(direct.outcome === 'completed' && direct.maxChunkGapMs >= 40 && pipeline.outcome === 'failed'
    && pipeline.attempts.length === 1, 'late final frames complete directly but fail app idle policy without retrying partial text');
  check(logs.some(line => line.includes('"timeoutStage":"idle"') && line.includes('"lastReadWaitMs":')
    && line.includes('"idleLimitMs":20')), 'idle failure retains actual read wait and configured limit');
  direct = await probeDirectStream({ body, key: 'private_probe_key', runtime, fetcher: fakeStream(5, ''), totalMs: 100 });
  check(direct.outcome === 'failed' && direct.protocolReason === 'missing_done', 'direct probe does not accept truncated text as success');
  direct = await probeDirectStream({ body, key: 'private_probe_key', runtime, fetcher: fakeStream(200), totalMs: 20 });
  check(direct.failure.reason === 'total_timeout', 'direct diagnostic has a bounded total deadline');
  direct = await probeDirectStream({ body, key: 'private_probe_key', runtime,
    fetcher: async () => new Response('private_probe_error_body', { status: 429, headers: { 'retry-after': '3' } }) });
  check(direct.status === 429 && direct.retryAfterMs === 3000 && direct.failure.reason === 'http_error', 'direct 429 report has retry delay without error body');

  const axiosPost = axios.post;
  try {
    axios.post = async () => { throw Object.assign(new Error('private_probe_service_error'), { isAxiosError: true,
      response: { status: 429, data: { message: 'private_probe_error_body' }, headers: { 'retry-after': '2', 'x-deepinfra-request-id': 'provider_service_123' } } }); };
    await assert.rejects(runtime.telemetry.meteredPost('summary', 'https://api.deepinfra.com/v1/openai/chat/completions', { model: apiModel }));
    check(logs.some(line => line.includes('service attempt failed') && line.includes('"purpose":"summary"')
      && line.includes('"retryAfterMs":2000') && line.includes('provider_service_123')), 'service 429 identifies purpose, request ID and retry delay');
  } finally { axios.post = axiosPost; }
  runtime.policy.chatModelStreamTimeouts = limits;
  globalThis.fetch = async () => new Response(text + terminal);
  const upstream = await runtime.helpers.streamChatCompletion(modelName, messages, 'private_probe_key');
  await assert.rejects(runtime.consumer.consumeOpenAIChatCompletion(upstream, () => { throw new TypeError('private_probe_delivery_error'); }));
  check(logs.some(line => line.includes('consumer failed') && line.includes('"stage":"deliver_delta"') && line.includes('TypeError')), 'downstream delivery failure has its own stage');
  globalThis.fetch = async () => new Response(Array.from({ length: 40 }, () => text).join('') + terminal);
  logs.length = 0;
  await probePipelineStream({ messages, modelName, key: 'private_probe_key', runtime });
  // Individual transport chunks, not SSE frames, drive the trace cap.
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) {
    for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode(text));
    c.enqueue(new TextEncoder().encode(terminal)); c.close();
  } }));
  logs.length = 0;
  await probePipelineStream({ messages, modelName, key: 'private_probe_key', runtime });
  check(logs.filter(line => line.includes('chunk received')).length === 20
    && logs.some(line => line.includes('"chunkCount":41')), 'trace capped at 20 chunks while summary counts entire stream');
  process.env.CHAT_TRANSPORT_TRACE = '0'; logs.length = 0;
  await probePipelineStream({ messages, modelName, key: 'private_probe_key', runtime });
  check(!logs.some(line => line.includes('[ChatTransport]')), 'successful transport trace is disabled by default');
  const remaining = runtime.diagnostics.beginAiTransport('deepinfra', apiModel, 'chat');
  check(remaining.fields().activeModelAtStart === 1, 'no active request leaks after success, timeout and consumer cancellation');
  remaining.release();
  globalThis.fetch = async () => { throw Object.assign(new TypeError('private_probe_network_error'), {
    cause: Object.assign(new Error('private_probe_socket_error'), { code: 'UND_ERR_SOCKET' }),
  }); };
  await assert.rejects(runtime.telemetry.meteredChatFetch('https://api.deepinfra.com/v1/openai/chat/completions', {}, apiModel, 1));
  check(logs.some(line => line.includes('"stage":"awaiting_headers"') && line.includes('UND_ERR_SOCKET')), 'fetch TypeError preserves allowlisted socket cause without error text');
  check(!audit.join('\n').includes('private_probe_'), 'output contains no prompt, reply, API key or private exception text');
  const dry = spawnSync(process.execPath, ['scripts/diagnose-chat-stream.mjs'], { encoding: 'utf8' });
  check(dry.status === 0 && dry.stdout.includes('"live":false') && dry.stdout.includes('Dry run only'), 'CLI defaults to dry run without API requests');
} finally {
  globalThis.fetch = nativeFetch;
  Object.assign(console, consoleBackup);
}
console.log(`Chat transport verification: ${checks} passed; no live provider or database calls.`);
