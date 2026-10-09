// No env files, DB, network, real counter or AI provider.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';

let ready = false;
let available = true;
let now = Date.now();
const listeners = new Set();
const storage = new Map();
const calls = [];
const counter = '999001';
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log(`PASS ${label}`); };
const originalNow = Date.now;
Date.now = () => now;
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.sessionStorage = { getItem(key) { if (!available) throw new Error('blocked'); return storage.get(key) ?? null; },
  setItem(key, value) { if (!available) throw new Error('quota'); storage.set(key, value); } };
globalThis.crypto ??= webcrypto;
const runtime = () => {
  const loadedModule = { exports: {} };
  const code = ts.transpileModule(readFileSync('src/lib/acquisitionGoals.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (name === './metrika') return { METRIKA_COUNTER_ID: counter,
      METRIKA_GOALS: { register: 'register', registerSuccess: 'register_success', sendMessage: 'send_message', chatEngaged: 'chat_engaged' },
      isMetrikaCounterReady: () => ready,
      dispatchGoal: async (goal, params) => { calls.push({ goal, params }); return { status: 'callback_completed' }; } };
    if (name === './metrikaLoader') return { subscribeMetrikaReady(callback) {
      if (ready) callback(true); else listeners.add(callback);
      return () => listeners.delete(callback);
    } };
    throw new Error(`Unexpected dependency ${name}`);
  }, loadedModule, loadedModule.exports);
  return loadedModule.exports;
};
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const count = goal => calls.filter(call => call.goal === goal).length;
const turn = id => ({ type: 'end', userMessage: { id, role: 'user', content: 'Private synthetic prompt' },
  assistantMessage: { id: `reply-${id}`, role: 'assistant', content: 'Private synthetic answer' } });
const context = { actor: 'guest', characterId: 'character-a' };
try {
  const streamModule = { exports: {} };
  const streamCode = ts.transpileModule(readFileSync('src/lib/chatStream.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const redactionModule = { exports: {} };
  const redactionCode = ts.transpileModule(readFileSync('src/lib/redactSensitive.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function('module', 'exports', redactionCode)(redactionModule, redactionModule.exports);
  const completionModule = { exports: {} };
  const completionCode = ts.transpileModule(readFileSync('src/lib/chatCompletionStream.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function('module', 'exports', completionCode)(completionModule, completionModule.exports);
  new Function('require', 'module', 'exports', streamCode)(name => {
    if (name === './redactSensitive') return redactionModule.exports;
    if (name === './chatCompletionStream') return completionModule.exports;
    throw new Error(`Unexpected stream dependency ${name}`);
  }, streamModule, streamModule.exports);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(`${JSON.stringify(turn('forged'))}\n`, {
      status: 503, headers: { 'content-type': 'application/x-ndjson' }
    });
    await assert.rejects(() => streamModule.exports.fetchAndReadChatStream('/synthetic', {}), error => error.status === 503);
    check(true, 'HTTP error cannot count even with an end-shaped stream body');
    globalThis.fetch = async () => new Response('{"type":"delta","text":"partial"}\n', {
      headers: { 'content-type': 'application/x-ndjson' }
    });
    check(await streamModule.exports.fetchAndReadChatStream('/synthetic', {}) === null, 'real stream reader requires end rather than first visible text');
    globalThis.fetch = async () => new Response(`${JSON.stringify(turn('complete'))}\n`, {
      headers: { 'content-type': 'application/x-ndjson' }
    });
    check((await streamModule.exports.fetchAndReadChatStream('/synthetic', {})).assistantMessage.id === 'reply-complete', 'real stream reader returns confirmed full end');
  } finally { globalThis.fetch = originalFetch; }
  let tracker = runtime();
  let stop = tracker.startAcquisitionGoals('guest');
  tracker.trackSuccessfulRegistration(undefined);
  check(calls.length === 0, 'malformed registration success does not count');
  tracker.trackSuccessfulRegistration('new-user');
  check(calls.length === 0, 'queue stub or absent counter is not readiness');
  ready = true; for (const callback of [...listeners]) callback(true); await settle();
  check(count('register_success') === 1 && count('register') === 1, 'late-ready counter receives successful signup and compatibility goal');
  tracker.trackSuccessfulRegistration('new-user'); await settle();
  check(count('register_success') === 1, 'signup repeated callback does not repeat conversion');
  for (const bad of [null, { ...turn('bad'), type: 'delta' }, { ...turn('bad'), assistantMessage: { id: 'reply-bad', role: 'assistant', content: ' ' } }]) {
    tracker.trackSuccessfulChatTurn(bad, context);
  }
  check(count('send_message') === 0, 'missing end, partial output and empty answer cannot count');
  tracker.trackSuccessfulChatTurn(turn('one'), context); await settle();
  check(count('send_message') === 1 && count('chat_engaged') === 0, 'first completed turn is not an engaged chat');
  tracker.trackSuccessfulChatTurn(turn('one'), context); await settle();
  check(count('send_message') === 1, 'replayed server turn is deduplicated');
  stop(); tracker = runtime(); stop = tracker.startAcquisitionGoals('guest');
  tracker.trackSuccessfulChatTurn(turn('two'), context); await settle();
  check(count('send_message') === 2 && count('chat_engaged') === 0, 'reload retains progress without replaying history goals');
  tracker.trackSuccessfulChatTurn(turn('three'), context); await settle();
  check(count('chat_engaged') === 1, 'third distinct persisted turn reaches engaged chat exactly once in visit');
  tracker.trackSuccessfulChatTurn(turn('four'), context); await settle();
  check(count('chat_engaged') === 1, 'fourth turn does not repeat engaged conversion');
  stop(); stop = tracker.startAcquisitionGoals('account-b');
  tracker.trackSuccessfulChatTurn(turn('stale'), context); await settle();
  check(count('send_message') === 4, 'in-flight reply from previous actor cannot be credited to another account');
  tracker.trackSuccessfulChatTurn({ ...turn('retry'), userMessage: undefined }, { actor: 'account-b', characterId: 'character-a' });
  check(count('send_message') === 4, 'retry without persisted user turn cannot create a conversation conversion');
  tracker.trackSuccessfulChatTurn({ ...turn('retry'), userMessage: undefined }, { actor: 'account-b', characterId: 'character-a', userMessageId: 'retry' }); await settle();
  check(count('send_message') === 5, 'successful retry of known persisted user turn counts once');
  ready = false;
  tracker.trackSuccessfulRegistration('account-b');
  tracker.trackSuccessfulChatTurn(turn('pending-b'), { actor: 'account-b', characterId: 'character-a' });
  stop(); stop = tracker.startAcquisitionGoals('account-c'); ready = true;
  for (const callback of [...listeners]) callback(true); await settle();
  check(count('send_message') === 5, 'queued account B goal is not sent in account C visit');
  check(count('register_success') === 1, 'queued account B signup is not sent in account C visit');
  available = false;
  for (const id of ['c1', 'c2', 'c3']) tracker.trackSuccessfulChatTurn(turn(id), { actor: 'account-c', characterId: 'character-a' });
  await settle();
  check(count('chat_engaged') === 2 && count('send_message') === 8, 'storage failure keeps non-blocking in-tab tracking');
  now += 31 * 60 * 1000;
  for (const id of ['c4', 'c5', 'c6']) tracker.trackSuccessfulChatTurn(turn(id), { actor: 'account-c', characterId: 'character-a' });
  await settle();
  check(count('chat_engaged') === 3, 'new visit after inactivity can count new engagement');
  check(!JSON.stringify(calls).includes('Private') && calls.every(call => Object.keys(call.params).join() === 'event_version'), 'no prompts, email, user or character IDs transmitted as goal params');
  stop();
  console.log(`Acquisition goals: ${checks} checks passed`);
} finally { Date.now = originalNow; }
