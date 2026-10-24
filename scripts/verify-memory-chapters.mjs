import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createModuleLoader } from './lib/memory-test-harness.mjs';

const forbidden = new Proxy({}, { get() { throw new Error('Database forbidden'); } });
const { load, root } = createModuleLoader({ prismaFor: () => forbidden });
const chapters = load(join(root, 'src/lib/memorySummaryChapters.ts'));
const evidence = load(join(root, 'src/lib/memorySummaryEvidence.ts'));
const policy = load(join(root, 'src/lib/memorySummaryPolicy.ts'));
const { countTokens } = load(join(root, 'src/lib/tokenCount.ts'));
let passed = 0;
async function check(label, fn) { await fn(); passed++; console.log(`PASS ${label}`); }
const names = { user: 'Артём', character: 'Вика' };
const core = '## Пользователь\n- Имя: Артём\n\n## Персонаж\n- Имя: Вика';
const story = text => ({ section: 'story', text, status: 'reported', sources: ['s1'] });
/** A provider stub: answers per mode and records what each call received. */
function stub(answers) {
  const calls = [];
  return { calls, ask: async (mode, input, budget, sourceIds) => {
    calls.push({ mode, input: JSON.parse(input), budget, sourceIds });
    const answer = answers[mode];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(JSON.parse(input)) : answer;
  } };
}
const context = (ask, maxTokens = 1500, count = countTokens) => ({ maxTokens, core, names, countTokens: count, ask });

await check('chapters are the lines under «Предыстория»; a summary without headings is one legacy chapter', () => {
  assert.deepEqual(chapters.splitSummaryChapters('Прежняя память.\nЕщё строка.'), { chapters: ['Прежняя память. Ещё строка.'], rest: '' });
  const text = '## Предыстория\nПервая глава.\nВторая глава.\n\n## Открытые планы\n- [Предложено; Пользователь] Сходить в кино.';
  const parts = chapters.splitSummaryChapters(text);
  assert.deepEqual(parts.chapters, ['Первая глава.', 'Вторая глава.']);
  assert.equal(parts.rest, '## Открытые планы\n- [Предложено; Пользователь] Сходить в кино.');
  assert.equal(chapters.composeChapterSummary(parts.chapters, parts.rest), text);
});

await check('a new chapter is appended and written chapters stay word for word; they are context, not sources', async () => {
  const previous = '## Предыстория\nВика и Артём встретились в клубе через три года после школы.\n\n## Открытые планы\n- [Предложено; Пользователь] Я предлагаю сходить в ресторан.';
  const provider = stub({ chapter: JSON.stringify({ items: [story('Вика и Артём поужинали в ресторане, и Артём предложил встречаться.')] }) });
  const messages = [{ role: 'assistant', content: 'Мы поужинали в ресторане, и ты предложил встречаться.' }];
  let stats;
  const result = await chapters.writeSummaryChapter(previous, messages, context(provider.ask), value => { stats = value; });
  assert.equal(result, '## Предыстория\nВика и Артём встретились в клубе через три года после школы.\nВика и Артём поужинали в ресторане, и Артём предложил встречаться.');
  const [call] = provider.calls;
  assert.equal(call.mode, 'chapter');
  assert.equal(call.input.previous, 'Вика и Артём встретились в клубе через три года после школы.');
  assert.ok(!call.input.sources.some(source => /клубе/.test(source.text)), 'a written chapter is never a source');
  assert.ok(call.input.sources.some(source => source.author === 'memory' && /ресторан/.test(source.text)), 'open plans are sources');
  assert.equal(call.budget, 750);
  assert.deepEqual(stats, { chapterCount: 2, newChapterCount: 1, compressedPairCount: 0, compressionFallbackCount: 0, budgetTrimmedSentenceCount: 0 });
});

await check('a new chapter drops sentences told before or repeated, and sees only the latest chapter', async () => {
  const told = ['Вика и Артём встретились в клубе через три года после школы.', 'Вика проснулась и обнаружила, что проспала весь день.'];
  const provider = stub({ chapter: input => JSON.stringify({ items: [{ ...story(
    'Вика проснулась и обнаружила, что проспала весь день. Утром Вика сварила кофе. Утром Вика сварила кофе.'),
    sources: [input.sources[0].id] }] }) });
  const result = await chapters.writeSummaryChapter(`## Предыстория\n${told.join('\n')}`,
    [{ role: 'assistant', content: 'Я проснулась, обнаружила, что проспала весь день, и утром сварила кофе.' }], context(provider.ask));
  assert.equal(result, `## Предыстория\n${told.join('\n')}\nУтром Вика сварила кофе.`);
  assert.equal(provider.calls[0].input.previous, told[1]);
});

await check('a past item in a chapter is an ordinary story item, and nothing old is carried forward', async () => {
  const previous = '## Предыстория\nВика отказала Артёму три года назад.\n\n## Открытые планы\n- [Предложено; Пользователь] Я предлагаю сходить в ресторан.';
  const provider = stub({ chapter: input => JSON.stringify({ items: [{ ...story('Вика и Артём поужинали в ресторане.'), section: 'past',
    sources: [input.sources.find(source => source.author !== 'memory').id] }] }) });
  const result = await chapters.writeSummaryChapter(previous, [{ role: 'assistant', content: 'Мы поужинали в ресторане.' }], context(provider.ask));
  assert.equal(result, '## Предыстория\nВика отказала Артёму три года назад.\nВика и Артём поужинали в ресторане.');
});

await check('overflow compresses only the two oldest chapters; the newest stays as written', async () => {
  const old = ['Вика и Артём учились в одной школе, и Артём признался Вике в чувствах.', 'Вика отказала Артёму, потому что боялась привязаться.',
    'Через три года они встретились в клубе и обменялись номерами.'];
  const provider = stub({
    chapter: JSON.stringify({ items: [story('Артём пригласил Вику в ресторан, и она согласилась.')] }),
    compress: input => JSON.stringify({ items: [{ ...story('Артём признался Вике в школе, а она отказала из страха привязаться.'), sources: input.sources.map(source => source.id).slice(0, 3) }] }),
  });
  const words = text => text.split(/\s+/).length;
  // A budget that holds the new chapter and three of the four chapters, counted in words.
  const limit = words(chapters.composeChapterSummary([...old, 'Артём пригласил Вику в ресторан, и она согласилась.'], '')) - 8;
  let stats;
  const result = await chapters.writeSummaryChapter(`## Предыстория\n${old.join('\n')}`, [{ role: 'user', content: 'Я приглашаю тебя в ресторан, и ты согласилась.' }],
    { ...context(provider.ask, limit, words) }, value => { stats = value; });
  const compress = provider.calls.find(call => call.mode === 'compress');
  assert.deepEqual(compress.input.sources.map(source => source.text), [old[0], old[1]]);
  assert.equal(result, `## Предыстория\nАртём признался Вике в школе, а она отказала из страха привязаться.\n${old[2]}\nАртём пригласил Вику в ресторан, и она согласилась.`);
  assert.equal(stats.compressedPairCount, 1); assert.equal(stats.chapterCount, 3);
});

await check('a refused compression keeps the opening sentences of both chapters and still fits', async () => {
  const old = ['Вика и Артём учились в одной школе. Артём признался Вике в чувствах. Вика ему отказала.',
    'Через три года они встретились в клубе. Они обменялись номерами. Артём подвёз Вику домой.', 'Вика написала Артёму первой.'];
  const provider = stub({ chapter: JSON.stringify({ items: [story('Артём пригласил Вику в ресторан, и она согласилась.')] }),
    compress: JSON.stringify({ items: [story('Петров украл у Вики машину.')] }) });
  const words = text => text.split(/\s+/).length;
  const limit = words(chapters.composeChapterSummary([...old, 'Артём пригласил Вику в ресторан, и она согласилась.'], '')) - 10;
  let stats;
  const result = await chapters.writeSummaryChapter(`## Предыстория\n${old.join('\n')}`, [{ role: 'user', content: 'Я приглашаю тебя в ресторан, и ты согласилась.' }],
    context(provider.ask, limit, words), value => { stats = value; });
  assert.ok(stats.compressionFallbackCount >= 1 && stats.compressedPairCount === 0);
  assert.ok(words(result) <= limit);
  assert.match(result, /^## Предыстория\nВика и Артём учились в одной школе\./);
  assert.match(result, /Через три года они встретились в клубе\./);
  assert.doesNotMatch(result, /Петров/);
  assert.match(result, /Артём пригласил Вику в ресторан, и она согласилась\.$/);
});

await check('a transport failure during compression defers the whole refresh instead of cutting chapters', async () => {
  const old = ['Первая глава о школе Вики и Артёма.', 'Вторая глава о клубе.', 'Третья глава о номерах.'];
  const provider = stub({ chapter: JSON.stringify({ items: [story('Артём пригласил Вику в ресторан, и она согласилась.')] }), compress: new Error('timeout') });
  await assert.rejects(chapters.writeSummaryChapter(`## Предыстория\n${old.join('\n')}`, [{ role: 'user', content: 'Я приглашаю тебя в ресторан, и ты согласилась.' }],
    context(provider.ask, 10, text => text.split(/\s+/).length)), /timeout/);
});

await check('an answer with nothing supported is a summary error, so chunk backoff still applies', async () => {
  const provider = stub({ chapter: JSON.stringify({ items: [story('Петров украл у Вики машину.')] }) });
  await assert.rejects(chapters.writeSummaryChapter('', [{ role: 'user', content: 'Я приглашаю тебя в ресторан.' }], context(provider.ask)),
    error => error instanceof policy.MemorySummaryError && error.code === 'MEMORY_SUMMARY_NO_FITTING_SOURCE');
});

await check('chapter prompt forbids re-telling the past; compression prompt keeps the turns of the story', () => {
  const chapter = chapters.summarySystemPrompt('chapter', 750, names);
  assert.ok(chapter.includes('previous — предыдущая записанная глава'));
  assert.ok(!chapter.includes('section=past: сжатый пересказ'));
  assert.ok(!chapter.includes('из них past'));
  assert.ok(chapter.includes('Участники: герой пользователя — Артём, персонаж — Вика.'));
  assert.ok(evidence.CHAPTER_SUMMARY_RULES.startsWith('MEMORY_GROUNDED_SUMMARY_V1'));
  const merge = chapters.summarySystemPrompt('merge', 1500, names);
  assert.ok(merge.includes('section=past: сжатый пересказ') && merge.includes('из них past — не больше 4'));
  const compress = chapters.summarySystemPrompt('compress', 300, names);
  assert.ok(compress.includes('Сожми их в одну главу') && compress.includes('признания, решения'));
});

console.log(`Memory chapters: ${passed} checks passed`);
