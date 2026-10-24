// Actual summary pipeline and distributed SQL claims on disposable PostgreSQL. No .env/live AI.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startHarness, createModuleLoader } from './lib/memory-test-harness.mjs';
const h = await startHarness({ label: 'memory-refresh' });
const { db, provider, helpers, root, load, countTokens } = h;
const memory = load(join(root, 'src/lib/chatMemory.ts'));
const policy = load(join(root, 'src/lib/memorySummaryPolicy.ts'));
const evidence = load(join(root, 'src/lib/memorySummaryEvidence.ts'));
const lease = load(join(root, 'src/lib/memorySummaryRefresh.ts'));
const safe = load(join(root, 'src/lib/logger.ts'));
let passed = 0;
async function check(label, fn) { await fn(); passed++; console.log(`PASS ${label}`); }
const originalPost = provider.axiosPost.bind(provider);
let finishReason = 'stop', latestSummaryBody;
provider.axiosPost = async (url, body) => {
  const response = await originalPost(url, body);
  if (provider.kindOf(body) === 'summary') {
    latestSummaryBody = body;
    response.data.choices[0].finish_reason = finishReason;
  }
  return response;
};
async function setup(content = 'Ключ лежит под ступенью.') {
  const user = await helpers.user('start');
  const character = await helpers.character(user.id);
  const rows = await helpers.messages(user.id, character.id, Array.from({ length: 70 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content,
  })), { embed: false });
  const scope = await helpers.scope(user.id, character.id);
  await db.memory.create({ data: { ...await helpers.key(user.id, character.id), summary: 'Прежняя память.',
    lastSummarizedAt: rows[0].createdAt, summarizedMessageCount: 1 } });
  return { user, scope, rows };
}
try {
  await check('JSON generation allowance is separate, bounded and larger on every tariff', () => {
    for (const size of [200, 500, 800, 1500]) assert.ok(policy.summaryGenerationLimit(size) > size && policy.summaryGenerationLimit(size) <= 4096);
  });
  await check('length is rejected even when the returned prefix happens to be valid JSON', () => {
    assert.throws(() => policy.readSummaryResponse({ choices: [{ finish_reason: 'length', message: { content: '{"items":[]}' } }] }),
      { code: 'MEMORY_SUMMARY_TRUNCATED' });
  });
  await check('bad JSON and invented source remain distinct safe failures', () => {
    const sources = [{ id: 's1', author: 'user', text: 'Ключ лежит под ступенью.' }];
    assert.throws(() => evidence.renderGroundedSummary('{"items":[', sources, 200, countTokens), { code: 'MEMORY_SUMMARY_INVALID_JSON' });
    assert.throws(() => evidence.renderGroundedSummary(JSON.stringify({ items: [{ section: 'events', text: 'Ключ лежит под ступенью.',
      sources: ['unknown'], status: 'reported' }] }), sources, 200, countTokens), { code: 'MEMORY_SUMMARY_UNSUPPORTED_ITEM' });
    const diagnostic = safe.toSafeDiagnostic(new policy.MemorySummaryError('MEMORY_SUMMARY_INVALID_JSON'));
    assert.equal(diagnostic.code, 'MEMORY_SUMMARY_INVALID_JSON'); assert.equal(diagnostic.name, 'MemorySummaryError');
    assert.ok(!('message' in diagnostic) && !('stack' in diagnostic));
  });
  const fixture = await setup();
  await check('refresh persists a grounded summary under the 200-token stored allowance', async () => {
    const result = await memory.resolveChatMemorySummary(fixture.scope, 'synthetic_memory_key', fixture.user);
    assert.ok(result && countTokens(result) <= 200); assert.match(result, /Ключ/);
    assert.equal(latestSummaryBody.max_tokens, policy.summaryGenerationLimit(200));
    assert.equal(latestSummaryBody.response_format.type, 'json_object');
    const saved = await db.memory.findUnique({ where: { threadId: fixture.scope.threadId } });
    assert.equal(saved.summarizedMessageCount, 45);
    assert.equal(saved.lastSummarizedAt.getTime(), fixture.rows[44].createdAt.getTime());
  });
  const broken = await setup();
  await check('narrative is saved and mirrored as prose by the actual refresh pipeline', async () => {
    const fixture = await setup('Я не нашёл пропавший ключ.');
    provider.summaryText = JSON.stringify({ items: [{ section: 'story', status: 'reported',
      text: 'Пользователь не нашёл пропавший ключ.', sources: ['s3'] }] });
    const summary = await memory.resolveChatMemorySummary(fixture.scope, 'synthetic_memory_key', fixture.user);
    assert.equal(summary, '## Предыстория\nПользователь не нашёл пропавший ключ.');
    assert.equal(latestSummaryBody.max_tokens, policy.summaryGenerationLimit(200));
    const saved = await db.memory.findUnique({ where: { threadId: fixture.scope.threadId } });
    const mirror = await db.memoryEntry.findMany({ where: { threadId: fixture.scope.threadId, type: 'summary' } });
    assert.equal(saved.summary, summary); assert.equal(saved.summarizedMessageCount, 45);
    assert.equal(mirror.length, 1); assert.equal(mirror[0].content, summary);
    provider.summaryText = null;
  });
  await check('a truncated answer keeps its complete items and never repairs the cut one', () => {
    const cut = '{"items":[{"section":"story","text":"Ключ {лежит} под \\"ступенью\\".","status":"reported","sources":["s1"]},'
      + '{"section":"events","text":"Ключ не';
    const result = policy.readSummaryResponse({ choices: [{ finish_reason: 'length', message: { content: cut } }] });
    assert.equal(result.finishReason, 'length');
    assert.deepEqual(JSON.parse(result.text).items.map(row => row.text), ['Ключ {лежит} под "ступенью".']);
    assert.throws(() => policy.readSummaryResponse({ choices: [{ finish_reason: 'length', message: { content: '{"items":[{"section":"story","text":"Клю' } }] }),
      { code: 'MEMORY_SUMMARY_TRUNCATED' });
  });
  await check('the generation allowance covers every item the schema allows', () => {
    const items = policy.groundedSummaryFormat(['s1'], 1500).json_schema.schema.properties.items.maxItems;
    assert.ok(policy.summaryGenerationLimit(1500) >= items * 400 || policy.summaryGenerationLimit(1500) === 4096);
  });
  await check('truncated generation leaves text and coverage unchanged and defers paid retries', async () => {
    finishReason = 'length';
    provider.summaryText = '{"items":[{"section":"events","text":"Ключ лежит';
    await assert.rejects(memory.resolveChatMemorySummary(broken.scope, 'synthetic_memory_key', broken.user), { code: 'MEMORY_SUMMARY_TRUNCATED' });
    provider.summaryText = null;
    const calls = provider.calls.filter(row => row.kind === 'summary').length;
    const kept = await db.memory.findUnique({ where: { threadId: broken.scope.threadId } });
    assert.equal(kept.summary, 'Прежняя память.'); assert.equal(kept.summarizedMessageCount, 1);
    assert.equal(await memory.resolveChatMemorySummary(broken.scope, 'synthetic_memory_key', broken.user), kept.summary);
    assert.equal(provider.calls.filter(row => row.kind === 'summary').length, calls);
    finishReason = 'stop';
  });
  await check('invalid JSON and unsupported facts cannot overwrite persisted memory', async () => {
    for (const text of ['{"items":[', JSON.stringify({ items: [{ section: 'events', text: 'Ключ найден.', sources: ['unknown'], status: 'done' }] })]) {
      const broken = await setup(); provider.summaryText = text;
      await assert.rejects(memory.resolveChatMemorySummary(broken.scope, 'synthetic_memory_key', broken.user));
      const kept = await db.memory.findUnique({ where: { threadId: broken.scope.threadId } });
      assert.equal(kept.summary, 'Прежняя память.'); assert.equal(kept.lastSummarizedAt.getTime(), broken.rows[0].createdAt.getTime());
    }
    provider.summaryText = null;
  });
  await check('DeepInfra receives the complete strict schema and JSON allowance through the actual service client', async () => {
    process.env.MEMORY_AI_PROVIDER = 'deepinfra'; process.env.DEEPINFRA_API_KEY = 'synthetic_di_key';
    const fixture = await setup();
    const result = await memory.resolveChatMemorySummary(fixture.scope, 'synthetic_memory_key', fixture.user);
    assert.ok(result && countTokens(result) <= 200);
    assert.equal(latestSummaryBody.model, 'mistralai/Mistral-Small-3.2-24B-Instruct-2506');
    assert.equal(latestSummaryBody.max_tokens, 768); assert.equal(latestSummaryBody.response_format.type, 'json_schema');
    assert.equal(latestSummaryBody.response_format.json_schema.strict, true);
    process.env.MEMORY_AI_PROVIDER = 'kodikrouter';
  });
  await check('DeepInfra summary schema constrains keys, statuses and allowed source IDs', () => {
    const format = policy.groundedSummaryFormat(['s1', 's2'], 200);
    assert.equal(format.type, 'json_schema'); assert.equal(format.json_schema.strict, true);
    assert.equal(format.json_schema.schema.additionalProperties, false);
    const items = format.json_schema.schema.properties.items;
    assert.equal(items.maxItems, 1); assert.equal(items.items.additionalProperties, false);
    assert.deepEqual(items.items.properties.sources.items.enum, ['s1', 's2']);
  });
  await check('oversized backlog selects whole oldest messages without splitting timestamp groups', () => {
    const rows = Array.from({ length: 70 }, (_, i) => ({ role: 'user', content: 'Смотритель хранит ключ. '.repeat(180),
      createdAt: new Date(1_700_000_000_000 + Math.floor(i / 2) * 1000) }));
    const chunk = memory.fitSummaryMessages(rows, null);
    assert.ok(chunk.length > 0 && chunk.length < rows.length); assert.equal(chunk[0], rows[0]);
    assert.notEqual(chunk.at(-1).createdAt.getTime(), rows[chunk.length].createdAt.getTime());
    const sources = evidence.makeSummarySources(chunk);
    assert.ok(countTokens(JSON.stringify({ sources, core: null })) <= 12000);
  });
  await check('a single oversized message cannot silently advance coverage', () => {
    assert.throws(() => memory.fitSummaryMessages([{ role: 'user', content: 'Смотритель хранит ключ. '.repeat(9000), createdAt: new Date() }], null),
      { name: 'MemorySummaryInputError' });
  });
  await check('a fitting first timestamp group is not lost by midpoint rounding', () => {
    const first = new Date(1700000000000), next = new Date(1700000001000);
    const rows = [{ role: 'user', content: 'Ключ лежит под ступенью.', createdAt: first },
      { role: 'assistant', content: 'Ключ лежит под ступенью.', createdAt: first },
      { role: 'user', content: 'Смотритель хранит ключ. '.repeat(9000), createdAt: next }];
    assert.deepEqual(memory.fitSummaryMessages(rows, null), rows.slice(0, 2));
  });
  await check('an answer with no supported item preserves memory/coverage and installs a long shared cooldown', async () => {
    const long = 'смотритель хранит ключ возле деревянной ступени в закрытой башне, '.repeat(12) + 'номер 17.';
    const fixture = await setup(long);
    provider.summaryText = JSON.stringify({ items: [{ section: 'state', text: 'Петров спрятал ключ в подвале.',
      status: 'reported', sources: ['s2'] }] });
    const result = await memory.resolveChatMemorySummary(fixture.scope, 'synthetic_memory_key', fixture.user);
    assert.equal(result, 'Прежняя память.');
    const saved = await db.memory.findUnique({ where: { threadId: fixture.scope.threadId } });
    assert.equal(saved.summary, result); assert.equal(saved.summarizedMessageCount, 1);
    assert.equal(saved.lastSummarizedAt.getTime(), fixture.rows[0].createdAt.getTime());
    const { createHash } = await import('node:crypto');
    const id = 'memory-summary:' + createHash('sha256').update(fixture.scope.threadId).digest('hex');
    const rows = await db.$queryRaw`SELECT EXTRACT(EPOCH FROM ("leaseUntil" - (NOW() AT TIME ZONE 'UTC'))) AS remaining FROM "EmbeddingBackfillLease" WHERE id = ${id}`;
    assert.ok(Number(rows[0].remaining) > 1700);
    const calls = provider.calls.filter(row => row.kind === 'summary').length;
    assert.equal(await memory.resolveChatMemorySummary(fixture.scope, 'synthetic_memory_key', fixture.user), result);
    assert.equal(provider.calls.filter(row => row.kind === 'summary').length, calls);
    provider.summaryText = null;
  });
  await check('actual refresh persists a short retelling of oversized evidence, never the quote itself', async () => {
    const long = 'смотритель хранит ключ возле деревянной ступени в закрытой башне, '.repeat(12) + 'номер 17.';
    const fixture = await setup(long);
    provider.summaryText = JSON.stringify({ items: [{ section: 'state', text: 'смотритель хранит ключ возле деревянной ступени.',
      status: 'reported', sources: ['s3'] }] });
    const result = await memory.resolveChatMemorySummary(fixture.scope, 'synthetic_memory_key', fixture.user);
    assert.ok(result && countTokens(result) <= 200); assert.match(result, /хранит ключ возле деревянной ступени\.$/);
    assert.doesNotMatch(result, /закрытой башне/);
    const saved = await db.memory.findUnique({ where: { threadId: fixture.scope.threadId } });
    assert.equal(saved.summary, result); assert.ok(saved.summarizedMessageCount > 1 && saved.summarizedMessageCount < fixture.rows.length);
    assert.equal(saved.lastSummarizedAt.getTime(), fixture.rows[saved.summarizedMessageCount - 1].createdAt.getTime());
    provider.summaryText = null;
  });
  await check('oversized single-message input is deferred before any paid request', async () => {
    const fixture = await setup();
    await db.message.update({ where: { id: fixture.rows[1].id }, data: { content: 'Смотритель хранит ключ. '.repeat(9000) } });
    const calls = provider.calls.filter(row => row.kind === 'summary').length;
    assert.equal(await memory.resolveChatMemorySummary(fixture.scope, 'synthetic_memory_key', fixture.user), 'Прежняя память.');
    assert.equal(provider.calls.filter(row => row.kind === 'summary').length, calls);
    const saved = await db.memory.findUnique({ where: { threadId: fixture.scope.threadId } });
    assert.equal(saved.summarizedMessageCount, 1); assert.equal(saved.lastSummarizedAt.getTime(), fixture.rows[0].createdAt.getTime());
  });
  await check('independent application processes share one database claim', async () => {
    const independent = createModuleLoader({ prismaFor: () => db }).load(join(root, 'src/lib/memorySummaryRefresh.ts'));
    let unblock, started;
    const running = new Promise(resolve => { started = resolve; });
    const first = lease.withSummaryRefreshLease('synthetic-concurrent-thread', async () => {
      started(); await new Promise(resolve => { unblock = resolve; }); return 'first';
    }, async () => 'unexpected');
    await running;
    assert.equal(await independent.withSummaryRefreshLease('synthetic-concurrent-thread', async () => 'duplicate', async () => 'skipped'), 'skipped');
    unblock(); assert.equal(await first, 'first');
    assert.equal(await independent.withSummaryRefreshLease('synthetic-concurrent-thread', async () => 'next', async () => 'unexpected'), 'next');
  });
  await check('a crashed owner can be replaced and cannot delete its successor', async () => {
    let unblock, started;
    const running = new Promise(resolve => { started = resolve; });
    const first = lease.withSummaryRefreshLease('synthetic-expired-thread', async () => {
      started(); await new Promise(resolve => { unblock = resolve; }); return 'old';
    }, async () => 'unexpected');
    await running;
    await db.$executeRaw`UPDATE "EmbeddingBackfillLease" SET "leaseUntil" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 second' WHERE id LIKE 'memory-summary:%'`;
    await assert.rejects(lease.withSummaryRefreshLease('synthetic-expired-thread', async () => { throw new Error('synthetic_failure'); }, async () => 'unexpected'));
    unblock(); await first;
    assert.equal(await lease.withSummaryRefreshLease('synthetic-expired-thread', async () => 'duplicate', async () => 'cooldown'), 'cooldown');
  });
  console.log(`Memory refresh: ${passed} checks passed`);
} finally { await h.stop(); }
