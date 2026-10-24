// Narrative regressions against actual memory functions. No .env, network or database.
// --baseline runs the same scenarios against HEAD without changing the working tree.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createModuleLoader } from './lib/memory-test-harness.mjs';
const { root, load } = createModuleLoader({
  prismaFor: () => new Proxy({}, { get() { throw new Error('Database forbidden'); } }),
  sourceRef: process.argv.includes('--baseline') ? 'HEAD' : undefined,
});
const evidence = load(join(root, 'src/lib/memorySummaryEvidence.ts'));
const memory = load(join(root, 'src/lib/chatMemory.ts'));
const policy = load(join(root, 'src/lib/memorySummaryPolicy.ts'));
const { countTokens } = load(join(root, 'src/lib/tokenCount.ts'));
let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`PASS ${label}`); }
  catch (error) { failed++; console.error(`FAIL ${label}: ${error.message}`); }
}
const item = (text, sources, status = 'reported', section = 'story') => ({ text, sources, status, section });
const render = (items, sources, budget = 800) => evidence.renderGroundedSummary(JSON.stringify({ items }), sources, budget, countTokens);

check('a multi-stage story explains proposal, completion and unresolved goal without false uncertainty', () => {
  const sources = evidence.makeSummarySources([
    { role: 'user', content: 'Я предложил проверить северный шлюз.' },
    { role: 'assistant', content: 'Я завершил проверку северного шлюза.' },
    { role: 'user', content: 'Я не нашёл пропавший ключ.' },
  ]);
  const text = 'Сначала пользователь предложил проверить северный шлюз. Затем персонаж завершил проверку северного шлюза. Пользователь не нашёл пропавший ключ.';
  const result = render([item(text, ['s1', 's2', 's3'])], sources);
  assert.equal(result, `## Предыстория\n${text}`);
  assert.doesNotMatch(result, /Неясно|\[|^- /m);
});
check('independent numerical facts and negations are checked per assertion, not per paragraph', () => {
  const sources = evidence.makeSummarySources([
    { role: 'user', content: 'Я передал капитану 2 ключа.' },
    { role: 'assistant', content: 'Я не нашёл тайник номер 17.' },
  ]);
  const text = 'Пользователь передал капитану 2 ключа. Персонаж не нашёл тайник номер 17.';
  assert.equal(render([item(text, ['s1', 's2'])], sources), `## Предыстория\n${text}`);
});
check('denial cannot be hidden by cherry-picking a positive source in the same citation', () => {
  const sources = evidence.makeSummarySources([
    { role: 'user', content: 'Я не отдавал ключ капитану.' },
    { role: 'assistant', content: 'Я передал ключ капитану.' },
  ]);
  assert.equal(render([item('Ключ передан капитану.', ['s1', 's2'])], sources), '');
});
check('changing numbers or adding an unsupported outcome never becomes narrative', () => {
  const sources = evidence.makeSummarySources([{ role: 'user', content: 'Я предлагаю повысить ставку до 5,5%.' }]);
  for (const text of ['Пользователь предлагает повысить ставку до 9%.', 'Пользователь повысил ставку до 5,5%.']) {
    assert.equal(render([item(text, ['s1'])], sources), '');
  }
});
check('a long story item need not repeat every quote it cites', () => {
  const sources = evidence.makeSummarySources([
    { role: 'user', content: 'Я пришёл в клуб с друзьями.' },
    { role: 'assistant', content: 'Привет.' },
    { role: 'assistant', content: 'Ладно, давай пересядем к вам.' },
  ]);
  const text = 'Пользователь пришёл в клуб с друзьями.';
  assert.equal(render([item(text, ['s1', 's2', 's3'])], sources), `## Предыстория\n${text}`);
});
check('a first-person promise cannot be assigned to the other participant', () => {
  const sources = evidence.makeSummarySources([{ role: 'assistant', content: 'Я обещаю вернуть ключ капитану.' }]);
  assert.equal(render([item('Пользователь обещает вернуть ключ капитану.', ['s1'], 'promised', 'plans')], sources), '');
});
check('a promise to help the other participant preserves subject and object', () => {
  const sources = evidence.makeSummarySources([{ role: 'user', content: 'Я обещаю помочь персонажу найти тайник номер 17 утром.' }]);
  const text = 'Пользователь обещал помочь персонажу найти тайник номер 17 утром.';
  assert.equal(render([item(text, ['s1'])], sources), `## Предыстория\n${text}`);
});
check('a shared sentence can describe two explicitly attributed steps', () => {
  const sources = evidence.makeSummarySources([
    { role: 'user', content: 'Я предложил проверить северный шлюз утром.' },
    { role: 'assistant', content: 'Я согласился сопровождать пользователя к северному шлюзу утром.' },
  ]);
  const text = 'Пользователь предложил проверить северный шлюз утром, и персонаж согласился сопровождать его.';
  assert.equal(render([item(text, ['s1', 's2'])], sources), `## Предыстория\n${text}`);
});
check('source order survives mixed legacy, labelled and prose memory', () => {
  const sources = evidence.sourcesFromSummaries('## Открытые планы\n- [Обещано; Персонаж] Я обещаю вернуть ключ.\n## Недавние события\n- Пользователь: «Капитан ушёл к маяку.»\n## Предыстория\nШлюз остаётся закрытым.');
  assert.deepEqual(sources.map(source => source.text), ['Я обещаю вернуть ключ.', 'Капитан ушёл к маяку.', 'Шлюз остаётся закрытым.']);
});
check('speaker survives repeated refresh while old memory remains secondary evidence', () => {
  const original = '## Открытые планы\n- [Обещано; Персонаж] Я обещаю вернуть ключ капитану.';
  const sources = evidence.sourcesFromSummaries(original);
  assert.equal(sources[0].author, 'memory'); assert.equal(sources[0].speaker, 'character');
  const summary = render([item('Персонаж обещает вернуть ключ капитану.', ['s1'], 'promised', 'plans')], sources);
  assert.match(summary, /Персонаж \(из прежней сводки\)/);
  const next = evidence.sourcesFromSummaries(summary);
  assert.equal(next[0].speaker, 'character'); assert.equal(next[0].status, 'promised');
  assert.equal(next[0].author, 'memory'); assert.doesNotMatch(next[0].text, /из прежней сводки/);
});
check('a lost speaker cannot make an old first-person promise change owner', () => {
  const sources = evidence.sourcesFromSummaries('## Открытые планы\n- [Обещано; Персонаж] Я обещаю вернуть ключ капитану.');
  assert.doesNotMatch(render([item('Пользователь обещает вернуть ключ капитану.', ['s1'], 'promised', 'plans')], sources), /Пользователь обещает/);
});
check('third-person backstory cannot change the actor on the next update', () => {
  const sources = evidence.sourcesFromSummaries('## Предыстория\nПользователь обещал вернуть ключ капитану.');
  assert.doesNotMatch(render([item('Персонаж обещал вернуть ключ капитану.', ['s1'])], sources), /Персонаж обещал/);
});
check('a real provider failure cannot turn a cancelled trip into an accomplished journey', () => {
  const sources = evidence.makeSummarySources([
    { role: 'user', content: 'Я предложил проверить северный шлюз утром.' },
    { role: 'assistant', content: 'Я согласился сопровождать пользователя к северному шлюзу утром.' },
    { role: 'user', content: 'Я отменил поход утром из-за шторма.' },
  ]);
  assert.equal(render([item('Пользователь и персонаж отправились к северному шлюзу утром.', ['s1', 's2', 's3'], 'cancelled', 'plans')], sources), '');
  assert.equal(render([item('Пользователь отправился к северному шлюзу утром.', ['s1'])], sources), '');
  const text = 'Пользователь отменил поход утром из-за шторма.';
  assert.equal(render([item(text, ['s1', 's2', 's3'])], sources), `## Предыстория\n${text}`);
});
check('backstory survives parse/rebuild and the next summary update', () => {
  const text = 'Пользователь предложил проверить северный шлюз. Персонаж завершил проверку северного шлюза.';
  const summary = `## Предыстория\n${text}`;
  assert.equal(memory.rebuildSummary(memory.parseSummarySections(summary)), summary);
  const sources = evidence.sourcesFromSummaries(summary);
  assert.equal(render([item(text, sources.map(source => source.id))], sources), summary);
});
check('backstory fits all tariff budgets without cutting sentences', () => {
  const sources = evidence.makeSummarySources([{ role: 'user', content: 'Я не нашёл пропавший ключ.' }]);
  const text = 'Пользователь не нашёл пропавший ключ.';
  for (const budget of [200, 500, 800, 1500]) {
    const summary = render([item(text, ['s1'])], sources, budget);
    assert.equal(summary, `## Предыстория\n${text}`); assert.ok(countTokens(summary) <= budget);
  }
  assert.equal(render([item(text, ['s1'])], sources, 5), '');
});
check('provider schema allows narrative in the single-item entry plan allowance', () => {
  const schema = policy.groundedSummaryFormat(['s1'], 200).json_schema.schema.properties.items;
  assert.ok(schema.items.properties.section.enum.includes('story')); assert.equal(schema.maxItems, 1);
});
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
