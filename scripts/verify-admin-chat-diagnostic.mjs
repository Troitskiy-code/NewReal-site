import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createChatDiagnosticRuntime, diagnosticRoot } from './lib/chat-diagnostic-runtime.mjs';

process.env.CHAT_AI_PROVIDER = 'deepinfra';
process.env.DEEPINFRA_API_KEY = 'private_admin_probe_key';
process.env.ADMIN_SECRET = 'private_admin_secret';
process.env.CHAT_TRANSPORT_TRACE = '0';
delete process.env.LOGTAIL_SOURCE_TOKEN; delete process.env.LOGTAIL_INGESTING_HOST;
const callbacks = [];
const runtime = createChatDiagnosticRuntime({ 'next/server': { after: fn => callbacks.push(fn) } });
const probe = runtime.load(join(diagnosticRoot, 'src/lib/adminChatDiagnostic.ts'));
const route = runtime.load(join(diagnosticRoot, 'src/app/api/admin/chat-diagnostics/route.ts'));
const model = probe.ADMIN_DIAGNOSTIC_MODELS[0];
const nativeFetch = globalThis.fetch, consoles = { ...console }, audit = [], bodies = [];
for (const method of ['log', 'info', 'error', 'warn']) console[method] = (...args) => audit.push(args.join(' '));
const frame = data => `data: ${JSON.stringify(data)}\n\n`;
const text = frame({ id: 'chatcmpl_admin_probe', choices: [{ delta: { content: 'private_admin_reply' } }] });
const final = frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + frame({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 9 } }) + 'data: [DONE]\n\n';
function fixture(delay = 0, tail = final) {
  return async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    let timer, target;
    const onAbort = () => { clearTimeout(timer); target.error(init.signal.reason); };
    return new Response(new ReadableStream({
      start(c) { target = c; c.enqueue(new TextEncoder().encode(text)); init.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { init.signal.removeEventListener('abort', onAbort); c.enqueue(new TextEncoder().encode(tail)); c.close(); }, delay); },
      cancel() { clearTimeout(timer); init.signal.removeEventListener('abort', onAbort); },
    }), { headers: { 'content-type': 'text/event-stream', 'x-deepinfra-request-id': 'admin_probe_id' } });
  };
}
const request = (method, data, headers = {}) => new Request('https://newvers.ai/api/admin/chat-diagnostics', { method,
  headers: { Authorization: 'Bearer private_admin_secret', Origin: 'https://newvers.ai', ...headers },
  ...(data ? { body: JSON.stringify(data) } : {}) });
let checks = 0;
function check(value, title) { assert.ok(value, title); checks++; consoles.log(`PASS ${title}`); }
try {
  check((await route.GET(request('GET', null, { Authorization: 'Bearer wrong' }))).status === 401, 'GET requires the admin credential');
  check((await route.POST(request('POST', { model, confirmed: true }, { Authorization: 'Bearer wrong' }))).status === 401, 'POST requires the admin credential');
  check((await route.POST(request('POST', { model, confirmed: true }, { Origin: 'https://other.example' }))).status === 403, 'cross-origin start rejected');
  check((await route.POST(request('POST', { model, confirmed: false }))).status === 400, 'billed start requires explicit confirmation');
  check((await route.POST(request('POST', { model: 'https://other.example', confirmed: true }))).status === 400, 'only two fixed catalog models allowed');
  check((await route.POST(request('POST', { model, confirmed: true, messages: 'private_admin_prompt' }))).status === 400, 'no customer messages or arbitrary parameters accepted');
  check((await route.POST(request('POST', { model, confirmed: true, padding: 'x'.repeat(1200) }))).status === 413, 'bounded request payload');
  check(bodies.length === 0 && callbacks.length === 0 && runtime.rows.size === 0, 'rejected requests cannot call provider or accounting');
  globalThis.fetch = fixture(5);
  const start = await route.POST(request('POST', { model, confirmed: true }));
  check(start.status === 202 && callbacks.length === 1 && bodies.length === 0, 'reserve job before scheduling work after response');
  check((await route.POST(request('POST', { model, confirmed: true }))).status === 409, 'second start rejected while running');
  const normalRequest = runtime.telemetry.withAiCostContext(async () => {
    const stream = await runtime.helpers.streamChatCompletion(model, [{ role: 'user', content: 'ordinary_user_prompt' }], 'private_admin_probe_key');
    await runtime.consumer.consumeOpenAIChatCompletion(stream, () => {});
  });
  await Promise.all([callbacks.shift()(), normalRequest]);
  const status = await (await route.GET(request('GET'))).json();
  check(status.job.state === 'finished' && status.job.observation === 'failure_not_reproduced', 'completed comparison readable through authenticated polling');
  check(status.job.direct.hasDone && status.job.direct.inputTokens === 11 && status.job.pipeline.attempts.length === 1, 'real parser and pipeline report completion, usage and attempts');
  const diagnosticBodies = bodies.filter(b => b.messages[0].role === 'system');
  check(diagnosticBodies.length === 2 && JSON.stringify(diagnosticBodies[0]) === JSON.stringify(diagnosticBodies[1]), 'admin direct and app paths serialize identical input and options');
  check(runtime.rows.size === 1 && [...runtime.rows.values()][0].outcome === 'completed', 'concurrent ordinary request persists normally; diagnostic requests create no DB rows');
  check(status.job.pipeline.observations.some(row => row.event === 'attempt ended' && row.hasDone), 'request-scoped observations collected even when production trace is disabled');
  check((await route.POST(request('POST', { model, confirmed: true }))).status === 409, 'cooldown blocks repeated billed starts');
  const limits = runtime.policy.chatModelStreamTimeouts;
  runtime.policy.chatModelStreamTimeouts = () => ({ firstByteMs: 200, idleMs: 15, totalMs: 300 });
  const isolated = createChatDiagnosticRuntime();
  isolated.policy.chatModelStreamTimeouts = runtime.policy.chatModelStreamTimeouts;
  const delayed = isolated.load(join(diagnosticRoot, 'src/lib/adminChatDiagnostic.ts'));
  globalThis.fetch = fixture(50);
  const delayedJob = delayed.reserveAdminDiagnostic(model);
  await delayed.executeAdminDiagnostic(delayedJob);
  check(delayedJob.direct.outcome === 'completed' && delayedJob.pipeline.outcome === 'failed'
    && delayedJob.pipeline.attempts.length === 1, 'long upstream pause completes directly and fails real idle policy without retrying partial text');
  check(delayedJob.pipeline.observations.some(row => row.timeoutStage === 'idle' && row.lastReadWaitMs >= 10), 'report identifies timeout stage and actual wait');
  runtime.policy.chatModelStreamTimeouts = limits;
  const truncated = await probe.directAdminProbe({}, 'private_admin_probe_key', fixture(0, ''), 100);
  check(truncated.outcome === 'failed' && truncated.protocolReason === 'missing_done', 'direct path refuses truncated protocol');
  const throttled = await probe.directAdminProbe({}, 'private_admin_probe_key', async () => new Response('private_error_body', { status: 429, headers: { 'retry-after': '2' } }));
  check(throttled.status === 429 && throttled.retryAfterMs === 2000 && throttled.reason === 'http_error', '429 retains only safe metadata');
  const timeout = await probe.directAdminProbe({}, 'private_admin_probe_key', fixture(200), 15);
  check(timeout.reason === 'total_timeout', 'direct path has a total deadline');
  audit.push(JSON.stringify(status), JSON.stringify(delayedJob), JSON.stringify(throttled), JSON.stringify(timeout));
  check(!audit.join('\n').match(/private_admin_(reply|key|secret|prompt)|private_error_body|ordinary_user_prompt/), 'responses and logs contain no secrets, user text, generated text or error body');
  check(process.env.CHAT_TRANSPORT_TRACE === '0' && process.env.DEEPINFRA_API_KEY === 'private_admin_probe_key', 'admin test never mutates global environment or logger sink');
} finally { globalThis.fetch = nativeFetch; Object.assign(console, consoles); }
console.log(`${checks} admin transport diagnostic checks passed.`);
