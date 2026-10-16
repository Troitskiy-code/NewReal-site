// Real helpers, SSE consumer, watchdogs and cost collector; synthetic DB/provider only.
// Virtual time tests the exact production limits. One optional wall-clock replay lasts 30 s.
// Never reads .env and never sends a network request.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createModuleLoader } from './lib/memory-test-harness.mjs';

for (const key of Object.keys(process.env)) {
  if (/^(LOGTAIL_|AI_COST_|DEEPINFRA_|CHAT_AI_PROVIDER|MEMORY_AI_PROVIDER)/.test(key)) delete process.env[key];
}
process.env['CHAT_AI_PROVIDER'] = 'deepinfra';
process.env['DEEPINFRA_API_KEY'] = 'synthetic_mistral_only';
process.env['DEEPINFRA_USD_RUB'] = '108.192';
const model = 'deepinfra:mistralai/Mistral-Small-3.2-24B-Instruct-2506';
const endpoint = 'https://api.deepinfra.com/v1/openai/chat/completions';
const encoder = new TextEncoder();
const frame = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const content = value => frame({ id: 'fixture_mistral_reply', choices: [{ delta: { content: value }, finish_reason: null }] });
const usage = frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, estimated_cost: 0.002 } });
const terminal = reason => frame({ choices: [{ delta: {}, finish_reason: reason }] }) + usage + 'data: [DONE]\r\n\r\n';
const native = { setTimeout, clearTimeout, now: Date.now, fetch: globalThis.fetch,
  info: console.info, error: console.error, log: console.log, warn: console.warn, debug: console.debug };
const flush = () => new Promise(resolve => setImmediate(resolve));
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; native.log(`PASS ${label}`); };

class Clock {
  now = 0;
  sequence = 0;
  pending = new Map();
  install() {
    Date.now = () => this.now;
    globalThis.setTimeout = (fn, delay, ...args) => {
      const handle = { id: ++this.sequence, unref() { return this; } };
      this.pending.set(handle, { at: this.now + Number(delay), fn: () => fn(...args), order: handle.id });
      return handle;
    };
    globalThis.clearTimeout = handle => this.pending.delete(handle);
  }
  async advance(target) {
    assert.ok(target >= this.now);
    await flush();
    for (;;) {
      const next = [...this.pending.entries()].filter(([, job]) => job.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[1].order - b[1].order)[0];
      if (!next) break;
      const [handle, job] = next;
      this.pending.delete(handle);
      this.now = job.at;
      job.fn();
      await flush();
    }
    this.now = target;
    await flush();
  }
}
function restoreTimers() {
  globalThis.setTimeout = native.setTimeout;
  globalThis.clearTimeout = native.clearTimeout;
  Date.now = native.now;
}
function modules(baseline = false) {
  const rows = new Map();
  let charges = 0;
  const db = {
    model: { findUnique: async () => null },
    aiCostEvent: {
      create: async ({ data }) => { rows.set(data.id, { ...data }); return data; },
      update: async ({ where, data }) => {
        if (data.chargedVC) charges++;
        Object.assign(rows.get(where.id), data);
        return rows.get(where.id);
      },
    },
  };
  const { root, load } = createModuleLoader({ prismaFor: () => db,
    sourceTransform: (file, source) => {
      // Mistral has been hidden from chat since 2026-10-16; keep its stream policy covered in case it returns.
      if (file.endsWith('deepinfraModels.ts')) {
        const visible = source.replace(/\n\s*"deepinfra:mistralai\/Mistral-Small-3\.2-24B-Instruct-2506",/, '');
        assert.notEqual(visible, source, 'fixture re-enables the hidden Mistral route');
        return visible;
      }
      // Replay the old policy using precisely the same consumer and metering code.
      return baseline && file.endsWith('testingChatModels.ts')
        ? source.replace('reasoning || mistral ? 45_000 : 20_000', 'reasoning ? 45_000 : 20_000') : source;
    },
  });
  return { helpers: load(join(root, 'src/lib/chatHelpers.ts')), stream: load(join(root, 'src/lib/chatStream.ts')),
    telemetry: load(join(root, 'src/lib/aiCostTelemetry.ts')), policy: load(join(root, 'src/lib/testingChatModels.ts')),
    rows, get charges() { return charges; } };
}
const current = modules(), baseline = modules(true);
const logs = [];
for (const level of ['error', 'info', 'log', 'warn', 'debug']) console[level] = (...args) => logs.push(args.join(' '));

function exercise(m, { events, headersAt = 0, actor = 'guest:fixture', close = true, clock }) {
  logs.length = 0;
  const started = Date.now();
  let requests = 0, signal, settled = false, result;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, endpoint);
    assert.equal(JSON.parse(init.body).model, model.slice('deepinfra:'.length));
    assert.equal(JSON.parse(init.body).stream_options.include_usage, true);
    requests++;
    signal = init.signal;
    if (headersAt) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, headersAt);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    const timers = new Set();
    let abort;
    const cleanup = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); signal.removeEventListener('abort', abort); };
    return new Response(new ReadableStream({
      start(controller) {
        abort = () => { cleanup(); controller.error(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        for (const [index, event] of events.entries()) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            controller.enqueue(typeof event.bytes === 'string' ? encoder.encode(event.bytes) : event.bytes);
            if (close && index === events.length - 1) { cleanup(); controller.close(); }
          }, event.at - headersAt);
          timers.add(timer);
        }
      },
      cancel() { cleanup(); },
    }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture_mistral_request' } });
  };
  const completion = m.telemetry.withAiCostContext(async () => {
    m.telemetry.setAiCostActor(actor, 'start');
    try {
      const upstream = await m.helpers.streamChatCompletion(model, [{ role: 'user', content: 'private_prompt' }], 'unused');
      let visible = '';
      const reply = await m.stream.consumeOpenAIChatCompletion(upstream, delta => { visible += delta; });
      assert.equal(reply.text, visible.trim());
      if (!actor.startsWith('guest:')) await m.telemetry.recordChatCostCharge(upstream, 4);
      result = { reply, elapsed: Date.now() - started };
    } catch (error) {
      result = { error, elapsed: Date.now() - started };
    }
    settled = true;
  });
  return { completion, get settled() { return settled; }, get result() { return result; },
    get requests() { return requests; }, get signal() { return signal; },
    get row() { return [...m.rows.values()].at(-1); }, clock };
}
async function virtual(m, options, inspect) {
  const clock = new Clock(); clock.install();
  try {
    const replay = exercise(m, { ...options, clock });
    await flush();
    await inspect(replay, clock);
    assert.ok(replay.settled, 'fixture must settle');
    await replay.completion;
    check(clock.pending.size === 0, 'all watchdog and fixture timers released');
    check(replay.requests === 1, 'partial response never launches an automatic retry');
    check(!logs.join('\n').includes('private_prompt') && !logs.join('\n').includes('private_answer'), 'diagnostics exclude prompt and reply');
    return replay;
  } finally { restoreTimers(); globalThis.fetch = native.fetch; }
}
try {
  check(current.policy.chatModelStreamTimeouts(model).idleMs === 45_000
    && baseline.policy.chatModelStreamTimeouts(model).idleMs === 20_000, 'Mistral idle allowance changes from 20 to 45 seconds');
  const policies = loadPolicies(current);
  for (const name of policies) {
    const limits = current.policy.chatModelStreamTimeouts(name), old = baseline.policy.chatModelStreamTimeouts(name);
    check(limits.firstByteMs === 15_000 && limits.totalMs === 120_000, `${name}: headers and absolute limit unchanged`);
    if (name !== model) check(limits.idleMs === old.idleMs, `${name}: unrelated model idle limit unchanged`);
  }
  const delayed = [{ at: 0, bytes: content('private_answer') }, { at: 30_000, bytes: content(' продолжение') + terminal('stop') }];
  await virtual(baseline, { events: delayed }, async (r, c) => {
    await c.advance(20_000);
    check(r.result.error?.stage === 'idle' && r.result.elapsed === 20_000, 'old policy reproduces the production idle abort');
    check(r.row.outcome === 'failed' && !r.row.chargedVC, 'old partial stream is not marked as a paid success');
  });
  for (const actor of ['guest:fixture', 'fixture_user']) {
    await virtual(current, { events: delayed, actor }, async (r, c) => {
      await c.advance(20_000); check(!r.settled && !r.signal.aborted, `${actor}: still waiting at the old limit`);
      await c.advance(30_000);
      check(r.result.reply?.text === 'private_answer продолжение' && r.result.reply.finishReason === 'stop', `${actor}: 30-second pause resumes and completes`);
      check(r.row.outcome === 'completed' && r.row.providerCostNative === 0.002 && r.row.outputTokens === 10, `${actor}: final usage survives the pause`);
      check(actor.startsWith('guest:') ? !r.row.chargedVC : r.row.chargedVC === 4 && current.charges === 1, `${actor}: guest is uncharged; user gets one cost annotation`);
    });
  }
  await virtual(current, { events: [{ at: 0, bytes: content('private_answer') }], close: false }, async (r, c) => {
    await c.advance(44_999); check(!r.settled, 'idle abort does not happen early');
    await c.advance(45_000);
    check(r.result.error?.stage === 'idle' && r.result.elapsed === 45_000 && r.signal.aborted, 'permanent silence still aborts at 45 seconds');
    check(r.row.outcome === 'failed' && !r.row.chargedVC && logs.some(line => line.includes('"timeoutStage":"idle"')), 'idle failure remains uncharged and correctly diagnosed');
  });
  await virtual(current, { headersAt: 10_000, events: [10_000, 40_000, 70_000, 100_000].map((at, index) => ({ at, bytes: index ? ': keepalive\r\n\r\n' : content('private_answer') })), close: false }, async (r, c) => {
    await c.advance(119_999); check(!r.settled, 'keepalives prevent idle timeout but do not complete the reply');
    await c.advance(120_000);
    check(r.result.error?.stage === 'total' && r.result.elapsed === 120_000, 'headers and active stream cannot reset the 120-second absolute deadline');
    check(r.row.outcome === 'failed' && logs.some(line => line.includes('"timeoutStage":"total"')), 'absolute deadline is distinguished from idle timeout');
  });
  for (const reason of ['stop', 'length']) {
    const bytes = encoder.encode(content('Привет 🌍'));
    const split = bytes.indexOf(0xf0) + 2; // Split a four-byte UTF-8 code point across body chunks.
    await virtual(current, { headersAt: 10_000, events: [{ at: 10_000, bytes: bytes.slice(0, split) },
      { at: 40_000, bytes: bytes.slice(split) }, { at: 70_000, bytes: terminal(reason) }] }, async (r, c) => {
      await c.advance(70_000);
      check(r.result.reply?.text === 'Привет 🌍' && r.result.reply.finishReason === reason, `${reason}: UTF-8/CRLF frame split and late terminal frame decode correctly`);
      check(r.row.providerCostNative === 0.002 && r.row.outcome === 'completed', `${reason}: separate usage frame after finish_reason is retained`);
    });
  }
  for (const [label, ending] of [['missing DONE', frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + usage],
    ['missing finish_reason', usage + 'data: [DONE]\r\n\r\n'], ['provider error', frame({ error: { message: 'private_answer' } }) + terminal('stop')]]) {
    await virtual(current, { events: [{ at: 0, bytes: content('private_answer') }, { at: 30_000, bytes: ending }] }, async (r, c) => {
      await c.advance(30_000);
      check(r.result.error?.code === 'incomplete_ai_stream' && r.row.outcome === 'failed' && !r.row.chargedVC, `${label}: longer wait never legitimises an incomplete stream`);
    });
  }
  if (process.argv.includes('--wall-clock')) {
    native.log('Running one 30-second wall-clock replay with the unmodified production timer values.');
    const r = exercise(current, { events: delayed });
    await r.completion;
    check(r.result.reply?.finishReason === 'stop' && r.result.elapsed >= 29_500 && r.result.elapsed < 45_000,
      'real timers: reply survives a 30-second pause and completes before the new idle deadline');
    check(r.requests === 1 && r.row.outcome === 'completed' && !r.row.chargedVC, 'real timers: one synthetic request, valid usage, no guest charge');
  }
} finally {
  restoreTimers(); globalThis.fetch = native.fetch;
  for (const level of ['error', 'info', 'log', 'warn', 'debug']) console[level] = native[level];
}
console.log(`Mistral controlled replay: ${checks} passed; no live DB or paid AI calls.`);

function loadPolicies(m) {
  // Include a legacy route as well as the actual DeepInfra catalogue.
  return [...m.policy.NON_DEFAULT_CHAT_MODEL_NAMES, 'openai/gpt-4o-mini'];
}
