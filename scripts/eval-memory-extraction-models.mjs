// Paid comparison of DeepInfra models for memory_extract: speed AND what survives the production validator.
// Spends well under $1: refuses to run without MEMORY_MODEL_EVAL_CONFIRM=paid and an explicit
// DEEPINFRA_API_KEY in the process environment (.env is never read).
// Run: MEMORY_MODEL_EVAL_CONFIRM=paid DEEPINFRA_API_KEY=... node scripts/eval-memory-extraction-models.mjs [--passes 2] [--out file.json]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createModuleLoader } from './lib/memory-test-harness.mjs';

if (process.env['MEMORY_MODEL_EVAL_CONFIRM'] !== 'paid' || !process.env['DEEPINFRA_API_KEY']?.trim()) {
  console.error('Refusing: set MEMORY_MODEL_EVAL_CONFIRM=paid and DEEPINFRA_API_KEY to run this paid evaluation deliberately.');
  process.exit(2);
}
const key = process.env['DEEPINFRA_API_KEY'].trim();
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const passes = Number(arg('--passes') ?? 2), out = arg('--out');
// --long: production-sized turns (a ~2k-char reply with the fact buried mid-text) and 140 context facts.
const long = process.argv.includes('--long'), only = (arg('--models') ?? '').split(',').filter(Boolean);
const forbidden = new Proxy({}, { get() { throw new Error('Database forbidden'); } });
const { root, load } = createModuleLoader({ prismaFor: () => forbidden });
const facts = load(join(root, 'src/lib/memoryFacts.ts'));
const { countTokens } = load(join(root, 'src/lib/tokenCount.ts'));

const ALL_MODELS = [
  { id: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506' },
  { id: 'google/gemma-4-31B-it-turbo', reasoning: true },
  { id: 'deepseek-ai/DeepSeek-V4-Flash-0731', reasoning: true },
  { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507' },
  { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { id: 'Qwen/Qwen3-Next-80B-A3B-Instruct' },
];
const MODELS = only.length ? ALL_MODELS.filter(model => only.some(part => model.id.includes(part))) : ALL_MODELS;
// expect: [subject (or 'npc:*'), allowed keys, value/subject substring]; forbid: same shape; none: the turn has no stable fact.
const TURNS = [
  { u: 'Меня зовут Артём, я работаю механиком в депо.', a: 'Приятно познакомиться, Артём. Меня зовут Лира, я хранительница городского архива.',
    expect: [['user', ['name'], 'Артём'], ['user', ['occupation'], 'механик'], ['character', ['name'], 'Лира'], ['character', ['occupation'], 'хранительниц']] },
  { u: 'Я недавно переехал из Казани в Самару.', a: 'Самара красивая, особенно набережная.',
    expect: [['user', ['city'], 'Самар']], forbid: [['user', ['city'], 'Казан']] },
  { u: 'Мне 27 лет, и я терпеть не могу кофе.', a: 'А я без кофе не могу проснуться по утрам.',
    expect: [['user', ['age'], '27'], ['user', ['dislikes'], 'коф'], ['character', ['likes', 'habits'], 'коф']], forbid: [['user', ['likes'], 'коф']] },
  { u: 'Может, завтра сходим в музей?', a: 'Давай, но только после обеда, утром я занята.', none: true },
  { u: 'Ты ведь любишь рыбалку?', a: 'Нет, рыбалку я никогда не любила, мне скучно сидеть на берегу.',
    expect: [['character', ['dislikes'], 'рыбалк']], forbid: [['character', ['likes'], 'рыбалк'], ['user', ['likes', 'dislikes'], 'рыбалк']] },
  { u: 'Я больше не работаю механиком, теперь учусь на врача.', a: 'Это смелое решение, уважаю.',
    expect: [['user', ['occupation'], 'врач']] },
  { u: 'Я умею играть на гитаре и неплохо готовлю.', a: 'Тогда с тебя ужин и песня!',
    expect: [['user', ['skills'], 'гитар'], ['user', ['skills'], 'готов']] },
  { u: 'Ты мне очень нравишься. Давай будем встречаться?', a: 'Я согласна. С этого дня мы пара.',
    expect: [['relationship', ['relationship.status'], '']] },
  { u: 'Расскажи, как прошёл твой день.', a: 'Я весь день разбирала старые карты в архиве и нашла чертёж маяка.', none: true },
  { u: 'В этом мире магия запрещена законом, за неё казнят.', a: 'Поэтому я прячу свои способности от стражи.',
    expect: [['world', ['world.rule'], 'маги']] },
  { u: 'Я снова в Казани, вернулся к родителям.', a: 'Рада, что ты дома.', expect: [['user', ['city'], 'Казан']] },
  { u: 'Наверное, мне около тридцати, точно не помню.', a: 'Возраст не главное.', none: true, forbid: [['user', ['age'], '']] },
  { u: 'Капитан Северов вчера увёл шхуну на юг.', a: 'Он всегда был упрямым.', expect: [['npc:*', ['occupation', 'name', 'personality'], 'Северов']],
    forbid: [['character', ['occupation'], 'капитан'], ['user', ['occupation'], 'капитан']] },
  { u: 'Ты сказала, что тебя зовут Лира, но это правда?', a: 'Честно говоря, Лира — это псевдоним. Моё настоящее имя Мирра.',
    expect: [['character', ['name'], 'Мирр']] },
  { u: 'Я ненавижу, когда мне врут.', a: 'Я запомню и не буду тебе врать.', expect: [['user', ['dislikes'], '']] },
  { u: 'Ты упоминала, что у тебя есть сестра?', a: 'Да, моя младшая сестра Ника учится в столице.', expect: [['npc:*', [], 'Ник']] },
];
// Unrelated context of a long story, so prefill and prompt shape match production.
const ACTIVE = Array.from({ length: long ? 140 : 60 }, (_, i) => ({ subject: i % 3 === 0 ? 'world' : i % 2 ? 'user' : 'character',
  key: i % 3 === 0 ? 'world.rule' : ['likes', 'habits', 'skills', 'personality'][i % 4],
  value: ['прогулки у северной пристани', 'чай с чабрецом по вечерам', 'чтение старых хроник', 'спокойный и вдумчивый',
    'по пятницам ярмарка у ворот', 'игра в шахматы', 'вязание у камина', 'ночные дежурства на стене'][i % 8] + ` ${i}`,
  pinned: false, source: i % 2 ? 'user_msg' : 'assistant_msg' }));

const FILLER = ['Ветер гонит по мостовой сухие листья, и где-то вдалеке звонит колокол.', 'Я поправляю воротник и на мгновение задумываюсь, глядя на огонь в очаге.',
  'За окном медленно темнеет, фонарщик зажигает огни вдоль улицы.', 'Мы молча слушаем, как дождь стучит по черепице.', 'Пахнет свежим хлебом и дымом из соседних труб.',
  'Я улыбаюсь краешком губ и отвожу взгляд к окну.', 'Где-то внизу хлопает дверь, и по лестнице кто-то поднимается.', 'Свеча на столе потрескивает и чуть коптит.',
  'Я перебираю пальцами край скатерти, подбирая слова.', 'Тишина в комнате кажется почти уютной.'];
const padded = (reply, index) => { if (!long) return reply; const text = i => FILLER[(index + i) % FILLER.length];
  const half = Array.from({ length: 14 }, (_, i) => text(i)).join(' '); return `${half} ${reply} ${Array.from({ length: 14 }, (_, i) => text(i + 5)).join(' ')}`; };
const matches = (fact, [subject, keys, needle]) => (subject === 'npc:*' ? fact.subject.startsWith('npc:') : fact.subject === subject)
  && (!keys.length || keys.includes(fact.key)) && (`${fact.subject} ${fact.value}`.toLowerCase().includes(needle.toLowerCase()));
async function call(model, turn, index) {
  const sources = facts.factSources([{ id: 'u', role: 'user', content: turn.u }, { id: 'a', role: 'assistant', content: padded(turn.a, index) }]);
  const input = JSON.stringify({ sources, activeFacts: ACTIVE });
  const body = { model: model.id, messages: [{ role: 'system', content: facts.FACT_EXTRACTION_RULES }, { role: 'user', content: input }],
    max_tokens: 2000, temperature: 0, response_format: facts.factExtractionFormat(sources.map(source => source.id)),
    ...(model.reasoning ? { reasoning_effort: 'none' } : {}) };
  const started = Date.now();
  try {
    const response = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    const ms = Date.now() - started;
    if (!response.ok) return { ms, error: `HTTP ${response.status}` };
    const data = await response.json(), choice = data.choices?.[0];
    const usage = { input: data.usage?.prompt_tokens ?? countTokens(input), output: data.usage?.completion_tokens ?? 0, cost: data.usage?.estimated_cost ?? null };
    if (choice?.finish_reason === 'length') return { ms, usage, error: 'truncated' };
    try {
      const parsed = facts.parseFactExtraction(choice?.message?.content ?? '', sources, { partial: true });
      return { ms, usage, accepted: parsed.facts, rejected: parsed.rejectedFacts + parsed.rejectedEvents, events: parsed.events.length };
    } catch (error) { return { ms, usage, error: `invalid:${error.diagnostic?.validationReason ?? error.message}` }; }
  } catch (error) { return { ms: Date.now() - started, error: error.name === 'TimeoutError' ? 'timeout' : 'network' }; }
}

const results = Object.fromEntries(MODELS.map(model => [model.id, []]));
// One worker per model: models run in parallel, each model's calls stay sequential so latency is not self-inflicted.
await Promise.all(MODELS.map(async model => {
  for (let pass = 0; pass < passes; pass++) for (const [index, turn] of TURNS.entries()) {
    const result = await call(model, turn, index);
    results[model.id].push({ pass, turn: index, ...result });
    process.stdout.write('.');
  }
}));
console.log('');
const pct = (values, p) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const report = [];
for (const model of MODELS) {
  const rows = results[model.id], ok = rows.filter(row => !row.error);
  let expected = 0, found = 0, falsePositive = 0;
  for (const row of ok) {
    const turn = TURNS[row.turn];
    for (const want of turn.expect ?? []) { expected++; if (row.accepted.some(fact => fact.op === 'set' && matches(fact, want))) found++; }
    for (const bad of turn.forbid ?? []) falsePositive += row.accepted.filter(fact => fact.op === 'set' && matches(fact, bad)).length;
    if (turn.none) falsePositive += row.accepted.filter(fact => fact.op === 'set').length;
  }
  const ms = ok.map(row => row.ms), output = ok.map(row => row.usage.output);
  const speed = ok.filter(row => row.usage.output > 50).map(row => row.usage.output / (row.ms / 1000));
  const cost = ok.reduce((sum, row) => sum + (row.usage.cost ?? 0), 0);
  report.push({ model: model.id, calls: rows.length, ok: ok.length, errors: Object.entries(rows.filter(row => row.error).reduce((m, row) => (m[row.error] = (m[row.error] ?? 0) + 1, m), {})).map(([k, v]) => `${k}×${v}`).join(', ') || '-',
    recall: expected ? Math.round(1000 * found / expected) / 10 : null, falsePositives: falsePositive,
    rejectedPerCall: ok.length ? Math.round(10 * ok.reduce((s, row) => s + row.rejected, 0) / ok.length) / 10 : null,
    p50: pct(ms, .5), p90: pct(ms, .9), max: ms.length ? Math.max(...ms) : null,
    outputAvg: output.length ? Math.round(output.reduce((a, b) => a + b, 0) / output.length) : null,
    tokPerSec: speed.length ? Math.round(speed.reduce((a, b) => a + b, 0) / speed.length) : null,
    costUsdPer1000Calls: ok.length ? Math.round(100000 * cost / ok.length) / 100 : null });
}
console.table(report);
if (out) writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), passes, long, turns: TURNS.length, report, results }, null, 1));
