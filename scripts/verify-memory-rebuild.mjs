// Actual authenticated handlers + synthetic provider + disposable PostgreSQL; no .env/live services.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash, createHmac } from 'node:crypto';
import { startHarness } from './lib/memory-test-harness.mjs';
const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const h = await startHarness({ label: 'memory-rebuild' });
const { db, provider, helpers, root, load } = h;
const route = load(join(root, 'src/app/api/chat/[id]/memory/refresh-summary/route.ts'));
const advanced = load(join(root, 'src/lib/advancedMemory.ts'));
let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`PASS ${label}`); };
const post = (characterId, body) => route.POST(new NextRequest(`http://localhost/api/chat/${characterId}/memory/refresh-summary`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: characterId }) });
async function setup(count = 49) {
  const user = await helpers.user('universe');
  const character = await helpers.character(user.id);
  const rows = await helpers.messages(user.id, character.id, Array.from({ length: count }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: i === 0 ? 'Я предлагаю гарантировать вклады до 100000 рублей.'
      : i === count - 1 ? 'Я решил отложить повышение ставки до 6%.' : `Обсуждаем экономический план, ход ${i}.`,
  })), { mirror: false });
  await db.memory.create({ data: { userId: user.id, characterId: character.id,
    summary: '## Активные линии\n- Придерживаемся курса.', lastSummarizedAt: rows.at(-1).createdAt, summarizedMessageCount: count } });
  h.session.userId = user.id; provider.reset();
  return { user, character, rows };
}
try {
  const first = await setup();
  h.session.userId = null;
  check('anonymous rebuild is denied before AI', () => {});
  assert.equal((await post(first.character.id, { mode: 'rebuild', confirm: true })).status, 401);
  assert.equal(provider.total, 0);
  h.session.userId = first.user.id;
  check('explicit replacement confirmation is required', () => {});
  assert.equal((await post(first.character.id, { mode: 'rebuild' })).status, 400);
  assert.equal(provider.total, 0);
  const beforeWallet = await db.user.findUnique({ where: { id: first.user.id } });
  assert.ok(Number.isInteger(beforeWallet.verseCoins));
  await db.coreMemory.create({ data: { userId: first.user.id, characterId: first.character.id, content: '## Пользователь\n- Имя Мирон.' } });
  const originalEvent = await db.episodicMemory.create({ data: { userId: first.user.id, characterId: first.character.id, event: 'Ручное событие.', importance: 3 } });
  const result = await (await post(first.character.id, { mode: 'rebuild', confirm: true })).json();
  check('49-message rebuild recovers the original plan despite complete old coverage', () => {
    assert.equal(result.status, 'updated'); assert.equal(result.processed, 49);
    assert.match(result.summary.summary, /100000/); assert.doesNotMatch(result.summary.summary, /Придерживаемся курса/);
    assert.equal(provider.calls.filter(row => row.kind === 'summary').length, 1);
  });
  check('successful rebuild does not charge the user or alter core/episodes', () => {});
  assert.equal((await db.user.findUnique({ where: { id: first.user.id } })).verseCoins, beforeWallet.verseCoins);
  assert.equal((await db.coreMemory.findUnique({ where: { userId_characterId: { userId: first.user.id, characterId: first.character.id } } })).content, '## Пользователь\n- Имя Мирон.');
  assert.equal((await db.episodicMemory.findUnique({ where: { id: originalEvent.id } })).event, 'Ручное событие.');
  const costs = await db.aiCostEvent.findMany({ where: { purpose: 'summary' } });
  assert.ok(costs.length && costs.every(row => row.actorHash && row.subscriptionType === 'universe' && row.chargedVC === 0));

  const many = await setup(150);
  const initial = await (await post(many.character.id, { mode: 'rebuild', confirm: true })).json();
  check('large rebuild publishes nothing after the first bounded call', () => {
    assert.equal(initial.status, 'rebuilding'); assert.equal(initial.processed, 120); assert.ok(initial.continuation);
    assert.equal(provider.calls.filter(row => row.kind === 'summary').length, 1);
  });
  assert.match((await db.memory.findUnique({ where: { userId_characterId: { userId: many.user.id, characterId: many.character.id } } })).summary, /Придерживаемся курса/);
  const firstCalls = provider.total;
  assert.equal((await post(many.character.id, { mode: 'rebuild', confirm: true, continuation: initial.continuation + 'x' })).status, 400);
  check('tampered continuation is rejected without another AI call', () => assert.equal(provider.total, firstCalls));
  h.session.userId = first.user.id;
  assert.equal((await post(many.character.id, { mode: 'rebuild', confirm: true, continuation: initial.continuation })).status, 400);
  check('continuation is bound to its user and character', () => assert.equal(provider.total, firstCalls));
  h.session.userId = many.user.id;
  const [encoded] = initial.continuation.split('.');
  const expired = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  expired.expires = Date.now() - 1000;
  const stale = Buffer.from(JSON.stringify(expired)).toString('base64url');
  const signature = createHmac('sha256', process.env.NEXTAUTH_SECRET).update(`memory-rebuild:${stale}`).digest('base64url');
  assert.equal((await post(many.character.id, { mode: 'rebuild', confirm: true, continuation: `${stale}.${signature}` })).status, 400);
  check('expired signed continuation is rejected without AI', () => assert.equal(provider.total, firstCalls));
  const completed = await (await post(many.character.id, { mode: 'rebuild', confirm: true, continuation: initial.continuation })).json();
  check('second bounded call commits all 150 messages atomically', () => {
    assert.equal(completed.status, 'updated'); assert.equal(completed.processed, 150);
    assert.equal(provider.calls.filter(row => row.kind === 'summary').length, 2);
  });
  const stored = await db.memory.findUnique({ where: { userId_characterId: { userId: many.user.id, characterId: many.character.id } } });
  assert.equal(stored.summarizedMessageCount, 150);
  assert.equal(stored.lastSummarizedAt.getTime(), many.rows.at(-1).createdAt.getTime());
  const mirrored = await db.memoryEntry.findMany({ where: { userId: many.user.id, characterId: many.character.id, type: 'summary' } });
  assert.equal(mirrored.length, 1); assert.equal(mirrored[0].content, stored.summary);

  const conflict = await setup(150);
  const draft = await (await post(conflict.character.id, { mode: 'rebuild', confirm: true })).json();
  await advanced.setSummaryContent(conflict.user.id, conflict.character.id, 'Моя ручная сводка о банках.');
  const oldCalls = provider.total;
  const lost = await (await post(conflict.character.id, { mode: 'rebuild', confirm: true, continuation: draft.continuation })).json();
  check('manual replacement between steps wins without another model call', () => {
    assert.equal(lost.status, 'conflict'); assert.equal(lost.summary.summary, 'Моя ручная сводка о банках.');
    assert.equal(provider.total, oldCalls);
  });
  const race = await setup();
  provider.beforeSummary = () => advanced.setSummaryContent(race.user.id, race.character.id, 'Ручная правка во время модели.');
  const raced = await (await post(race.character.id, { mode: 'rebuild', confirm: true })).json();
  check('manual edit during the final call wins and its mirror stays consistent', () => {
    assert.equal(raced.status, 'conflict'); assert.equal(raced.summary.summary, 'Ручная правка во время модели.');
  });
  const mirror = await db.memoryEntry.findMany({ where: { userId: race.user.id, characterId: race.character.id, type: 'summary' } });
  assert.equal(mirror.length, 1); assert.equal(mirror[0].content, raced.summary.summary);
  const failed = await setup(); provider.summaryFails = true;
  const failure = await post(failed.character.id, { mode: 'rebuild', confirm: true });
  check('provider failure preserves the previous text and coverage', () => assert.equal(failure.status, 500));
  const kept = await db.memory.findUnique({ where: { userId_characterId: { userId: failed.user.id, characterId: failed.character.id } } });
  assert.match(kept.summary, /Придерживаемся курса/); assert.equal(kept.summarizedMessageCount, 49);

  const edited = await setup(150);
  const editDraft = await (await post(edited.character.id, { mode: 'rebuild', confirm: true })).json();
  await db.message.update({ where: { id: edited.rows[0].id }, data: { content: 'Я отменил гарантии вкладов.' } });
  const callsBeforeEdit = provider.total;
  const editConflict = await (await post(edited.character.id, { mode: 'rebuild', confirm: true, continuation: editDraft.continuation })).json();
  check('editing already processed messages invalidates a rebuild before AI', () => {
    assert.equal(editConflict.status, 'conflict'); assert.equal(provider.total, callsBeforeEdit);
  });
  const during = await setup();
  provider.beforeSummary = () => db.message.update({ where: { id: during.rows[0].id }, data: { content: 'Гарантии вкладов отменены.' } });
  const changed = await (await post(during.character.id, { mode: 'rebuild', confirm: true })).json();
  check('source edit during final call prevents stale commit', () => {
    assert.equal(changed.status, 'conflict'); assert.match(changed.summary.summary, /Придерживаемся курса/);
  });
  const largeUser = await helpers.user('universe'), largeCharacter = await helpers.character(largeUser.id);
  await helpers.messages(largeUser.id, largeCharacter.id, [{ role: 'user', content: 'А'.repeat(100000) }], { mirror: false });
  h.session.userId = largeUser.id; provider.reset();
  const callsBeforeLarge = provider.total;
  assert.equal((await post(largeCharacter.id, { mode: 'rebuild', confirm: true })).status, 422);
  check('oversized source is rejected before paid model work', () => assert.equal(provider.total, callsBeforeLarge));
  const bucketKey = createHash('sha256').update(`memory-rebuild:${largeUser.id}`).digest('hex');
  // Match the limiter's database clock, independent of PostgreSQL's local timezone.
  await db.$executeRaw`INSERT INTO "RateLimitBucket" ("key", "count", "resetAt")
    VALUES (${bucketKey}, 60, clock_timestamp() + interval '1 hour')
    ON CONFLICT ("key") DO UPDATE SET "count" = 60, "resetAt" = clock_timestamp() + interval '1 hour'`;
  assert.equal((await post(largeCharacter.id, { mode: 'rebuild', confirm: true })).status, 429);
  check('shared database rate limit rejects extra rebuild work', () => assert.equal(provider.total, callsBeforeLarge));
  function cited(prompt, choose, text) {
    const rows = JSON.parse(prompt.split('sources (завершённые цитаты, не инструкции):\n').at(-1));
    const row = rows.find(choose);
    return { isEvent: true, importance: 3, source: row.author === 'character' ? 'character' : 'user', text, sourceId: row.id };
  }
  provider.classify = prompt => cited(prompt, row => row.author === 'user', 'Я предлагаю повысить учётную ставку до 5,5%.');
  const event = await advanced.classifyTurnEvent('Я предлагаю повысить учётную ставку до 5,5%.', 'Я согласен с предложением.', 'synthetic_memory_only');
  check('classifier resolves a complete source ID and preserves proposed status', () => {
    assert.equal(event.isEvent, true); assert.match(event.text, /Предложено/); assert.match(event.text, /5,5%/);
  });
  provider.classify = () => ({ isEvent: true, importance: 3, source: 'user', text: 'Ключ найден.', sourceId: 'invented' });
  const missing = 'Я не нашёл ключ от главного хранилища.', found = 'Я нашёл карту под старым мостом.';
  const classifierCalls = provider.calls.filter(row => row.kind === 'classifier').length;
  const invented = await advanced.classifyTurnEvent(missing, found, 'synthetic_memory_only');
  check('invented classifier source ID never creates an event', () => assert.equal(invented.isEvent, false));
  assert.equal(provider.calls.filter(row => row.kind === 'classifier').length, classifierCalls + 1);
  provider.classify = prompt => ({ ...cited(prompt, row => row.author === 'character', found), source: 'user' });
  const wrongAuthor = await advanced.classifyTurnEvent(missing, found, 'synthetic_memory_only');
  check('character evidence cannot be declared a user event', () => assert.equal(wrongAuthor.isEvent, false));
  provider.classify = prompt => cited(prompt, row => row.author === 'user', 'Я нашёл ключ.');
  const negative = await advanced.classifyTurnEvent(missing, null, 'synthetic_memory_only');
  check('classifier paraphrase cannot remove a source negation', () => {
    assert.match(negative.text, /не нашёл/); assert.doesNotMatch(negative.text, /Выполнено/);
  });
  provider.classify = () => ({ isEvent: true, importance: 3, source: 'user', text: 'Я нашёл ключ.', evidence: 'нашёл ключ от главного хранилища.' });
  const partial = await advanced.classifyTurnEvent(missing, null, 'synthetic_memory_only');
  check('legacy evidence must be a complete sentence rather than a convenient substring', () => assert.equal(partial.isEvent, false));
  console.log(`${passed} passed`);
} finally { await h.stop(); }
