// Expands the crash-test outline (docs/crash-test-witcher-outline-2026-10-28.json) into 250 user turns,
// chapter by chapter, with a DeepInfra model playing the user. Planted facts must appear in their turn;
// probe turns come verbatim from the outline. Writes docs/crash-test-witcher-turns-2026-10-28.json.
// node scripts/build-crash-test-turns.mjs --paid [--model Qwen/Qwen3-235B-A22B-Instruct-2507]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse } from 'dotenv';

const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
if (!process.argv.includes('--paid')) throw new Error('Requires --paid; it calls a paid text provider.');
const config = { ...process.env };
for (const file of ['.env', '.env.local']) if (existsSync(file)) Object.assign(config, parse(readFileSync(file)));
const MODEL = arg('--model') ?? 'Qwen/Qwen3-235B-A22B-Instruct-2507';
const outline = JSON.parse(readFileSync('docs/crash-test-witcher-outline-2026-10-28.json', 'utf8'));
const OUT = 'docs/crash-test-witcher-turns-2026-10-28.json';

const SYSTEM = `Ты пишешь реплики ИГРОКА для ролевой игры во вселенной «Ведьмака». Игрок управляет героиней ${outline.hero}; рассказчик (другая модель) отвечает за мир и всех остальных персонажей.
Правила для каждой реплики:
- от первого лица героини, по-русски, 1–3 предложения, не длиннее 280 знаков;
- действия героини в *звёздочках*, её прямая речь без кавычек или после тире;
- только то, что делает и говорит сама героиня: не описывай ответы, решения и действия NPC и исход её действий — это делает рассказчик;
- реплики продолжают друг друга и ведут сюжет главы по порядку;
- если для реплики указан факт, героиня проговаривает его явно и полностью (имена, числа, названия — как в факте).
Ответ — только JSON: {"turns":["…","…"]} ровно с указанным числом реплик.`;

async function call(user) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${config.DEEPINFRA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
        temperature: 0.8, max_tokens: 4000, response_format: { type: 'json_object' } }), signal: AbortSignal.timeout(120_000) });
    const data = await response.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content ?? '';
    try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).turns; } catch { /* retry */ }
  }
  throw new Error('No valid JSON from the model');
}

const turns = [];
const probes = new Map(outline.probes.flatMap(probe => probe.turn === 246
  ? probe.questions.map((question, index) => [probe.turn + index, question])
  : [[probe.turn, probe.questions.join(' ')]]));
for (const chapter of outline.chapters) {
  const [from, to] = chapter.turns;
  if (probes.has(from)) { for (let turn = from; turn <= to; turn++) turns[turn - 1] = probes.get(turn); continue; }
  const count = to - from + 1;
  const facts = outline.facts.filter(fact => fact.turn >= from && fact.turn <= to)
    .map(fact => `- реплика №${fact.turn - from + 1}: ${fact.text}`).join('\n');
  const recent = turns.filter(Boolean).slice(-4).join('\n');
  const user = `Глава (ходы ${from}–${to}, нужно ровно ${count} реплик): ${chapter.beats}
${facts ? `Факты, которые героиня обязана проговорить в указанных репликах:\n${facts}\n` : ''}${recent ? `Последние реплики игрока перед главой:\n${recent}\n` : ''}`;
  let batch = await call(user);
  if (!Array.isArray(batch) || batch.length !== count) batch = await call(`${user}\nВ прошлый раз было неверное число реплик. Нужно ровно ${count}.`);
  if (!Array.isArray(batch) || batch.length !== count) throw new Error(`Chapter ${from}-${to}: got ${batch?.length} turns`);
  batch.forEach((text, index) => { turns[from - 1 + index] = String(text).trim(); });
  console.log(`chapter ${from}-${to}: ${count} turns`);
}
if (turns.length !== 250 || turns.some(turn => !turn)) throw new Error(`Expected 250 turns, got ${turns.filter(Boolean).length}`);
writeFileSync(OUT, JSON.stringify({ about: outline.about, hero: outline.hero, facts: outline.facts,
  probeTurns: [...probes.keys()], turns }, null, 2) + '\n');
console.log(`written ${OUT}`);
