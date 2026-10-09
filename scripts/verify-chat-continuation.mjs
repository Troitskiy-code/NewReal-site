// Real handlers and a disposable PostgreSQL database; synthetic SSE only.
// No .env, production database, live provider requests or paid purchases.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { startHarness } from './lib/memory-test-harness.mjs';

const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const h = await startHarness({ label: 'chat-continuation' });
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log(`PASS ${label}`); };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
let reply = 'Одинокий Ветер', reason = 'stop', broken = false;
const originalFetch = h.provider.fetch.bind(h.provider);
h.provider.fetch = async (url, init) => {
  const original = await originalFetch(url, init);
  await original.body.cancel();
  const payload = frame({ choices: [{ delta: { content: reply } }] })
    + (broken ? frame({ error: { code: 'synthetic_failure' } })
      : frame({ choices: [{ delta: {}, finish_reason: reason }] }) + 'data: [DONE]\n\n');
  return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
};

async function post(user, character, body, regenerate = false) {
  h.session.userId = user.id;
  const path = regenerate ? 'src/app/api/chat/[id]/regenerate/route.ts' : 'src/app/api/chat/[id]/route.ts';
  const route = h.load(join(h.root, path));
  const response = await route.POST(new NextRequest(`http://localhost/api/chat/${character.id}${regenerate ? '/regenerate' : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: character.id }) });
  const events = (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  await h.settle();
  return { status: response.status, events, meta: events.find(event => event.type === 'meta'), end: events.find(event => event.type === 'end') };
}

async function history(user, character) {
  h.session.userId = user.id;
  const route = h.load(join(h.root, 'src/app/api/chat/[id]/route.ts'));
  const response = await route.GET(new NextRequest(`http://localhost/api/chat/${character.id}`), {
    params: Promise.resolve({ id: character.id }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).messages;
}

async function verifyCharges(user, count, label) {
  const transactions = await h.db.transaction.findMany({ where: { userId: user.id, type: 'chat' } });
  const actorHash = createHmac('sha256', process.env['AI_COST_HASH_KEY'] || process.env['NEXTAUTH_SECRET'])
    .update(user.id).digest('hex');
  const costs = await h.db.aiCostEvent.findMany({ where: { actorHash, purpose: 'chat', chargedVC: { gt: 0 } } });
  check(transactions.length === count && transactions.every(row => row.amount === -4)
    && (await h.db.user.findUnique({ where: { id: user.id } })).verseCoins === user.verseCoins - count * 4,
  `${label}: exactly one 4 VC debit per successful operation`);
  check(costs.length === count && costs.every(row => row.chargedVC === 4 && row.outcome === 'completed'),
    `${label}: successful chat cost annotations match paid operations`);
}

try {
  await h.helpers.model();
  const migration = readFileSync(join(h.root, 'prisma/migrations/20261009210000_message_finish_reason/migration.sql'), 'utf8');
  const legacyUser = await h.helpers.user(), legacyCharacter = await h.helpers.character(legacyUser.id);
  const legacyRow = await h.db.message.create({ data: { userId: legacyUser.id, characterId: legacyCharacter.id,
    chatId: legacyCharacter.id, role: 'assistant', content: 'Старый законченный ответ' } });
  await h.db.$transaction(async tx => {
    // Simulate the previous schema in this disposable database only.
    await tx.$executeRawUnsafe('ALTER TABLE "Message" DROP COLUMN "finishReason"');
    const before = await tx.$queryRawUnsafe('SELECT indexname FROM pg_indexes WHERE tablename = \'Message\' ORDER BY indexname');
    await tx.$executeRawUnsafe(migration);
    await tx.$executeRawUnsafe(migration);
    const after = await tx.$queryRawUnsafe('SELECT indexname FROM pg_indexes WHERE tablename = \'Message\' ORDER BY indexname');
    check(JSON.stringify(before) === JSON.stringify(after), 'migration is repeatable and preserves existing indexes');
  });
  const restored = await h.db.message.findUnique({ where: { id: legacyRow.id } });
  check(restored.content === legacyRow.content && restored.finishReason === null,
    'migration preserves historical text and leaves finish reason unknown');

  const helpers = h.load(join(h.root, 'src/lib/chatHelpers.ts'));
  for (const [content, finishReason, expected] of [
    ['Одинокий Ветер', 'stop', false], ['Одинокий Ветер.', 'stop', false],
    ['Одинокий Ветер', 'length', true], ['Одинокий Ветер.', 'length', true],
    ['Незакрытая «цитата', 'stop', false], ['Задумчиво…', 'stop', false],
    ['Незакрытая «цитата.', 'stop', false],
    ['Одинокий Ветер', null, false], ['Одинокий Ветер.', null, false],
    ['«Одинокий Ветер»', null, false], ['Короткий заголовок', undefined, false],
    ['Незакрытая «цитата', null, true], ['Незакрытая (скобка', null, true],
    ['Незакрытая «цитата.', null, true], ['Незакрытая (скобка.', null, true], ['«Законченная цитата.»', null, false],
    ['Мы ушли, потому что', null, true], ['Мы увидели:', null, true], ['Он задумался…', null, true],
  ]) check(helpers.isAssistantMessageCutOff(content, finishReason) === expected,
    `decision ${JSON.stringify(content)} / ${String(finishReason)} = ${expected}`);

  for (const initialReason of ['stop', 'length']) {
    for (const punctuation of ['', '.']) {
      const label = `${initialReason}, ${punctuation ? 'with' : 'without'} punctuation`;
      const user = await h.helpers.user(), character = await h.helpers.character(user.id);
      reason = initialReason; reply = `Одинокий Ветер${punctuation}`;
      const first = await post(user, character, { message: 'Назови короткий позывной.' });
      check(first.end?.assistantMessage.finishReason === initialReason, `${label}: generated answer exposes real finish reason`);
      const saved = (await history(user, character)).find(row => row.id === first.end.assistantMessage.id);
      check(saved?.finishReason === initialReason && saved.content === reply, `${label}: history/reload preserves finish reason`);
      reason = 'stop'; reply = 'Новая сцена.';
      const continuation = await post(user, character, { continue: true });
      const appends = initialReason === 'length';
      check(Boolean(continuation.meta.appendToId) === appends
        && (continuation.end.assistantMessage.id === saved.id) === appends,
      `${label}: metadata and persisted message agree on append versus new reply`);
      const current = await h.db.message.findUnique({ where: { id: saved.id } });
      check(current.content === (appends ? `${saved.content} Новая сцена.` : saved.content),
        `${label}: completed original is preserved; truncated original is extended`);
      check(continuation.end.assistantMessage.finishReason === 'stop'
        && await h.db.message.count({ where: { userId: user.id, characterId: character.id, role: 'assistant' } }) === (appends ? 1 : 2),
      `${label}: terminal reason is refreshed without duplicate assistant rows`);
      await verifyCharges(user, 2, label);
    }
  }

  // Successive continuations replace the old reason, so a newly completed reply stops appending.
  {
    const user = await h.helpers.user(), character = await h.helpers.character(user.id);
    reason = 'length'; reply = 'Первая часть.';
    const first = await post(user, character, { message: 'Расскажи историю.' });
    reply = 'Вторая часть.';
    const second = await post(user, character, { continue: true });
    reason = 'stop'; reply = 'Финал';
    const third = await post(user, character, { continue: true });
    reply = 'Следующая история';
    const fourth = await post(user, character, { continue: true });
    check(second.end.assistantMessage.id === first.end.assistantMessage.id && second.end.assistantMessage.finishReason === 'length'
      && third.end.assistantMessage.id === first.end.assistantMessage.id && third.end.assistantMessage.finishReason === 'stop'
      && fourth.end.assistantMessage.id !== first.end.assistantMessage.id,
    'length → length → stop chain stops appending after completion, including period-free final text');
    await verifyCharges(user, 4, 'continuation chain');
  }

  for (const newReason of ['stop', 'length']) {
    const user = await h.helpers.user(), character = await h.helpers.character(user.id);
    reason = newReason === 'stop' ? 'length' : 'stop'; reply = 'Прежний ответ.';
    const first = await post(user, character, { message: 'Опиши берег.' });
    reason = newReason; reply = 'Новый ответ';
    const regenerated = await post(user, character, { messageId: first.end.assistantMessage.id }, true);
    check(regenerated.end.assistantMessage.id === first.end.assistantMessage.id
      && regenerated.end.assistantMessage.finishReason === newReason
      && (await history(user, character)).find(row => row.id === first.end.assistantMessage.id)?.finishReason === newReason,
    `regenerate replaces previous finish reason with ${newReason}`);
    reason = 'stop'; reply = 'Продолжение.';
    const next = await post(user, character, { continue: true });
    check((next.end.assistantMessage.id === first.end.assistantMessage.id) === (newReason === 'length'),
      `Continue after regenerate follows new ${newReason} rather than stale reason`);
    await verifyCharges(user, 3, `regenerate ${newReason}`);
  }

  for (const [content, appends] of [['Короткий заголовок', false], ['Законченный ответ.', false], ['Незакрытая «цитата', true]]) {
    const user = await h.helpers.user(), character = await h.helpers.character(user.id);
    const original = await h.db.message.create({ data: { userId: user.id, characterId: character.id,
      chatId: character.id, role: 'assistant', content } });
    reason = 'stop'; reply = 'Новый текст.';
    const result = await post(user, character, { continue: true });
    check((result.end.assistantMessage.id === original.id) === appends,
      `legacy NULL reason: ${JSON.stringify(content)} uses structural fallback`);
    await verifyCharges(user, 1, `legacy ${content}`);
  }

  for (const [originalReason, edited, appends] of [
    ['length', 'Завершённый ручной ответ', false], ['stop', 'Незакрытая «ручная цитата', true],
  ]) {
    const user = await h.helpers.user(), character = await h.helpers.character(user.id);
    reason = originalReason; reply = 'Прежний ответ';
    const first = await post(user, character, { message: 'Опиши берег.' });
    const route = h.load(join(h.root, 'src/app/api/messages/[id]/route.ts'));
    const response = await route.PUT(new NextRequest(`http://localhost/api/messages/${first.end.assistantMessage.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: edited, finishReason: originalReason }),
    }), { params: Promise.resolve({ id: first.end.assistantMessage.id }) });
    const editedMessage = await response.json();
    check(response.status === 200 && editedMessage.finishReason === null,
      `manual edit clears stale ${originalReason}, ignoring caller-supplied finish reason`);
    reason = 'stop'; reply = 'Дальше.';
    const next = await post(user, character, { continue: true });
    check((next.end.assistantMessage.id === editedMessage.id) === appends,
      `manual edit of ${originalReason}: Continue follows edited text rather than old termination`);
    await verifyCharges(user, 2, `manual edit ${originalReason}`);
  }

  {
    const user = await h.helpers.user(), character = await h.helpers.character(user.id);
    reason = 'stop'; reply = 'Первый ответ.';
    await post(user, character, { message: 'Опиши берег.' });
    reason = 'length'; reply = 'Повторный ответ.';
    const retry = await post(user, character, { retryLast: true });
    check(retry.end.assistantMessage.finishReason === 'length'
      && (await history(user, character)).find(row => row.id === retry.end.assistantMessage.id)?.finishReason === 'length',
    'retryLast persists the new finish reason in the event and reloaded history');
    await verifyCharges(user, 2, 'retryLast');
  }

  for (const regenerate of [false, true]) {
    const user = await h.helpers.user(), character = await h.helpers.character(user.id);
    const original = await h.db.message.create({ data: { userId: user.id, characterId: character.id,
      chatId: character.id, role: 'assistant', content: 'Сохранённый ответ.', finishReason: 'length' } });
    broken = true; reply = 'Частичный текст';
    const failed = await post(user, character, regenerate ? { messageId: original.id } : { continue: true }, regenerate);
    broken = false;
    const current = await h.db.message.findUnique({ where: { id: original.id } });
    check(!failed.end && failed.events.some(event => event.type === 'error')
      && current.content === original.content && current.finishReason === 'length',
    `failed ${regenerate ? 'regenerate' : 'continue'} preserves content and termination metadata`);
    await verifyCharges(user, 0, `failed ${regenerate ? 'regenerate' : 'continue'}`);
  }
  console.log(`Chat continuation verification: ${checks} passed`);
} finally { await h.stop(); }
