// Deterministic stream fixtures only: no .env, database or provider requests.
import assert from 'node:assert/strict';
import { consumeOpenAIChatStream, createChatNdjsonResponse } from '../src/lib/chatStream.ts';
import { ChatCompletionStreamParser, ChatCompletionStreamError } from '../src/lib/chatCompletionStream.ts';

let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log(`PASS ${label}`); };
const frame = chunk => `data: ${JSON.stringify(chunk)}\n\n`;
const text = frame({ choices: [{ delta: { content: 'Ответ 🌌' } }] });
const terminal = reason => frame({ choices: [{ delta: {}, finish_reason: reason }] });
const usage = frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.1 } });
const done = 'data: [DONE]\n\n';
const error = frame({ error: { message: 'secret_provider_error', code: 'provider_error' } });
const stream = (payload, size = 7) => {
  const bytes = new TextEncoder().encode(payload); let offset = 0;
  return new ReadableStream({ pull(c) {
    if (offset >= bytes.length) { c.close(); return; }
    c.enqueue(bytes.slice(offset, offset + size)); offset += size;
  } });
};
for (const size of [1, 2, 7, 1024]) {
  let deltas = '';
  const reply = await consumeOpenAIChatStream(stream(text + terminal('stop') + usage + done, size), delta => { deltas += delta; });
  check(reply === 'Ответ 🌌' && deltas === reply, `valid stop/usage/DONE with UTF8 byte chunks ${size}`);
}
check(await consumeOpenAIChatStream(stream(text + terminal('length') + done), () => {}) === 'Ответ 🌌',
  'length remains a valid truncated reply for Continue');
check(await consumeOpenAIChatStream(stream(text + terminal('stop') + done), () => {}) === 'Ответ 🌌',
  'missing usage does not invalidate a completed answer');
check(await consumeOpenAIChatStream(stream((text + terminal('stop') + done).replaceAll('\n', '\r\n')), () => {}) === 'Ответ 🌌',
  'CRLF is supported across byte boundaries');
check(await consumeOpenAIChatStream(stream(text + terminal('stop') + 'data: [DONE]'), () => {}) === 'Ответ 🌌',
  'terminal frame without trailing newline is flushed');
const multiline = 'data: {"choices":\n' + 'data: [{"delta":{"content":"multiline"}}]}\n\n';
check(await consumeOpenAIChatStream(stream(': keepalive\n\nid: 7\n' + multiline + terminal('stop') + done), () => {}) === 'multiline',
  'multiline SSE data and comments use frame boundaries');

const invalid = [
  ['partial/error/EOF', text + usage + error],
  ['partial/error/stop/DONE', text + error + terminal('stop') + done],
  ['error after DONE', text + terminal('stop') + done + error],
  ['text/EOF', text],
  ['text/usage/EOF', text + usage],
  ['stop without DONE', text + terminal('stop')],
  ['DONE without stop', text + done],
  ['finish after DONE', text + done + terminal('stop')],
  ['content_filter', text + terminal('content_filter') + done],
  ['tool_calls', text + terminal('tool_calls') + done],
  ['unknown finish', text + terminal('unexpected') + done],
  ['empty answer', terminal('stop') + done],
  ['malformed data', text + 'data: {broken\n\n' + terminal('stop') + done],
  ['explicit SSE error event', text + 'event: error\ndata: {}\n\n' + terminal('stop') + done],
  ['text after terminal choice', text + terminal('stop') + text + done],
  ['oversized data frame', 'data: ' + 'x'.repeat(1_000_001) + '\n\n' + text + terminal('stop') + done],
];
for (const [label, payload] of invalid) {
  let charged = 0, received;
  try { await consumeOpenAIChatStream(stream(payload, 65536), () => {}); charged++; }
  catch (e) { received = e; }
  check(charged === 0 && received instanceof ChatCompletionStreamError && received.__noRetry === true
    && !received.message.includes('secret_provider'), `${label}: safe failure, no downstream charge/retry`);
  const chunks = [], parser = new ChatCompletionStreamParser(chunk => chunks.push(chunk));
  parser.push(payload);
  check(parser.end() === 'failed', `${label}: accounting classifier also fails`);
}
const measured = [], parser = new ChatCompletionStreamParser(chunk => measured.push(chunk));
parser.push(text + usage + error);
check(parser.end() === 'failed' && measured.some(chunk => chunk.usage?.cost === 0.1), 'known usage retained on failed stream');
let cancelCalled = false;
const controller = new AbortController();
const pending = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); }, cancel() { cancelCalled = true; } });
const cancelled = consumeOpenAIChatStream(pending, () => { controller.abort(); }, controller.signal);
await assert.rejects(cancelled, e => e.name === 'AbortError');
check(cancelCalled && !pending.locked, 'abort cancels and releases upstream reader');
let callbackCancel = false;
const callbackStream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); }, cancel() { callbackCancel = true; } });
await assert.rejects(consumeOpenAIChatStream(callbackStream, () => { throw new Error('client_callback_failure'); }), /client_callback_failure/);
check(callbackCancel && !callbackStream.locked, 'delta callback failure propagates and cancels upstream');
const log = console.error; console.error = () => {};
try {
  let charged = false;
  const response = createChatNdjsonResponse(async () => {
    await consumeOpenAIChatStream(stream(text + error), () => {});
    charged = true;
  });
  const wire = await response.text();
  check(!charged && wire.includes('"type":"error"') && !wire.includes('secret_provider_error')
    && !wire.includes('"type":"end"'), 'real NDJSON wrapper exposes only a safe error, no successful end');
} finally { console.error = log; }
console.log(`Cost streams verification: ${checks} passed`);
