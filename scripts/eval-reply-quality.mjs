// Paid reply-quality eval: the chat model answers trap messages after a replayed story, a judge model scores
// each reply against a fixed rubric. Prompts are built by the production code (src/lib/chatSystemPrompt.ts),
// loaded from git refs, so a prompt change is compared with the previous one on the same stories.
// node scripts/eval-reply-quality.mjs --paid --out <dir> [--variants HEAD,working] [--samples 3] [--cases id,id]
// Keys come from .env.local (DEEPINFRA_API_KEY for the chat model, KIE_API_KEY for the judge). Replies and
// verdicts are written only to --out; the console gets pass rates, scores and costs.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { createModuleLoader } from './lib/memory-test-harness.mjs';

const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
if (!process.argv.includes('--paid')) throw new Error('Live evaluation requires --paid; it calls paid text providers.');
const outDir = arg('--out');
if (!outDir) throw new Error('--out is required');
mkdirSync(outDir, { recursive: true });
const config = { ...process.env };
for (const file of ['.env', '.env.local']) if (existsSync(file)) Object.assign(config, parse(readFileSync(file)));

const CHAT_MODEL = arg('--model') ?? 'google/gemma-4-31B-it-turbo';
const CHAT_PRICE = [0.09, 0.34]; // USD per 1M tokens, DeepInfra catalog 2026-10-11
const JUDGE_MODEL = arg('--judge') ?? 'Qwen/Qwen3-235B-A22B-Instruct-2507';
const JUDGE_PRICE = JUDGE_MODEL.includes('Qwen') ? [0.09, 0.55] : [0.75, 3.5]; // DeepInfra: Qwen3-235B, else Kimi K2.6 pricing
const JUDGE_REASONING = /Kimi|GLM|DeepSeek|MiMo/.test(JUDGE_MODEL);
const SAMPLES = Number(arg('--samples') ?? 3);
const HISTORY_TOKENS = 12_000;
const VARIANTS = (arg('--variants') ?? 'HEAD,working').split(',');
const spec = JSON.parse(readFileSync('docs/reply-quality-cases-2026-10-26.json', 'utf8'));
const scenario = JSON.parse(readFileSync('docs/memory-modes-test-2026-10-24.json', 'utf8')).scenario;
const onlyCases = arg('--cases')?.split(',');
const cases = spec.cases.filter(item => !onlyCases || onlyCases.includes(item.id));

const loaders = Object.fromEntries(VARIANTS.map(ref => [ref, createModuleLoader({
  prismaFor: () => { throw new Error('Database forbidden'); }, sourceRef: ref === 'working' ? null : ref })]));
const { countTokens } = loaders[VARIANTS[0]].load(join(loaders[VARIANTS[0]].root, 'src/lib/tokenCount.ts'));
const prompts = Object.fromEntries(VARIANTS.map(ref => [ref, loaders[ref].load(join(loaders[ref].root, 'src/lib/chatSystemPrompt.ts'))]));
const memoryFormats = Object.fromEntries(VARIANTS.map(ref => [ref, loaders[ref].load(join(loaders[ref].root, 'src/lib/memoryPromptFormat.ts'))]));

const cost = { chatIn: 0, chatOut: 0, judgeCredits: 0, judgeIn: 0, judgeOut: 0 };
async function post(url, headers, body, timeout = 120_000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
      const data = await response.json();
      if (response.ok && (data.choices || data.content || data.data)) return data.data && !data.choices && !data.content ? data.data : data;
      if (attempt === 2) throw new Error(`HTTP ${response.status} ${String(data.msg ?? data.error?.message ?? '').slice(0, 160)}`);
    } catch (error) { if (attempt === 2) throw error; }
    await new Promise(resolve => setTimeout(resolve, 4000 * (attempt + 1)));
  }
}

/** The production request shape: system prompt, then the story (greeting first), cut to the history budget. */
function chatMessages(ref, story, history, memory = null) {
  const prompt = prompts[ref];
  const base = prompt.assembleRoleplayPrompt(spec.cards[story], 'ru', {}).content;
  // A case may carry memory blocks; production appends them to the system prompt the same way.
  const system = memory ? memoryFormats[ref].appendMemorySection(base, ['core', 'events', 'summary']
    .filter(kind => memory[kind]).map(kind => ({ kind, body: memory[kind] })), 'ru') : base;
  const kept = [];
  let tokens = 0;
  for (const message of [...history].reverse()) {
    tokens += countTokens(message.content) + 4;
    if (tokens > HISTORY_TOKENS) break;
    kept.unshift(message);
  }
  const messages = [{ role: 'system', content: system }, ...kept];
  return typeof prompt.withTurnReminder === 'function'
    ? prompt.withTurnReminder(messages, 'ru') : messages;
}
async function chat(messages) {
  const data = await post('https://api.deepinfra.com/v1/openai/chat/completions', { Authorization: `Bearer ${config.DEEPINFRA_API_KEY}` },
    { model: CHAT_MODEL, messages, max_tokens: 1000, temperature: 0.7, reasoning_effort: 'none' });
  cost.chatIn += data.usage?.prompt_tokens ?? 0; cost.chatOut += data.usage?.completion_tokens ?? 0;
  return { text: data.choices?.[0]?.message?.content ?? '', finish: data.choices?.[0]?.finish_reason };
}

/** The story before the traps: the first scenario turns answered once with the baseline prompt, then cached. */
async function prefix(story) {
  const file = join(outDir, `prefix-${story}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const history = [{ role: 'assistant', content: spec.cards[story].greeting }];
  for (const turn of scenario[story].slice(0, spec.prefixTurns)) {
    history.push({ role: 'user', content: turn });
    history.push({ role: 'assistant', content: (await chat(chatMessages(VARIANTS[0], story, history))).text });
  }
  writeFileSync(file, JSON.stringify(history, null, 1));
  return history;
}

const RUBRIC = `Ты проверяешь ОДИН ответ ролевой модели. Отвечай только JSON.
1. target — вопрос проверки дан в сообщении. violated=true, если ответ на этот вопрос «да», то есть нарушение есть.
2. agency — violated=true, если ответ описывает НОВЫЕ действия, реплики, мысли, чувства, решения или выводы героя пользователя, которых нет в его последнем сообщении («ты киваешь», «вы говорите…», «Кай решает…», «вы чувствуете страх», «вы берёте…»). Не нарушение: пересказ своими словами того, что герой сам заявил в последнем сообщении («Эйра спускается в шахту», «Кай подходит к пульту»); что он видит и слышит вокруг и что окружение делает с ним (ветер бьёт в лицо); слова и действия ДРУГИХ персонажей (NPC); вопросы к герою. Нарушение — только шаг дальше заявленного: новое действие, реплика, мысль, чувство или решение самого героя.
3. score — 1–5: насколько это хороший ролевой ход (характеры, живость, отклик на сцену).
Сначала найди цитату, потом решай. Формат: {"target":{"quote":"…","violated":false},"agency":{"quote":"…","violated":false},"score":4}
quote — дословный фрагмент ответа, на котором основано решение, или пустая строка, если нарушения нет.`;
async function judge(item, history, userText, reply) {
  const recent = history.slice(-6).map(message => `${message.role === 'user' ? 'ПОЛЬЗОВАТЕЛЬ' : 'АССИСТЕНТ'}: ${message.content.slice(0, 1500)}`).join('\n\n');
  const user = `Режим: ${spec.cards[item.story].roleplayMode}. Карточка: ${spec.cards[item.story].name}. Герой пользователя: ${spec.heroes[item.story]}.
Заметки к случаю: ${item.notes}
Вопрос проверки (target): ${item.check}

Последние сообщения истории:
${recent}

ПОСЛЕДНЕЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ: ${userText}

ОЦЕНИВАЕМЫЙ ОТВЕТ:
${reply}`;
  let text;
  if (JUDGE_MODEL.includes('/')) {
    // A DeepInfra model id («Qwen/…»): OpenAI chat shape.
    const data = await post('https://api.deepinfra.com/v1/openai/chat/completions', { Authorization: `Bearer ${config.DEEPINFRA_API_KEY}` },
      { model: JUDGE_MODEL, messages: [{ role: 'system', content: RUBRIC }, { role: 'user', content: user }], temperature: 0,
        // Reasoning judges (Kimi, GLM, DeepSeek) think briefly before the verdict.
        ...(JUDGE_REASONING ? { max_tokens: 3000, reasoning_effort: 'low' } : { max_tokens: 600, response_format: { type: 'json_object' } }) });
    cost.judgeIn += data.usage?.prompt_tokens ?? 0; cost.judgeOut += data.usage?.completion_tokens ?? 0;
    text = data.choices?.[0]?.message?.content ?? '';
  } else {
    const data = await post('https://api.kie.ai/claude/v1/messages', { Authorization: `Bearer ${config.KIE_API_KEY}` },
      { model: JUDGE_MODEL, system: RUBRIC, messages: [{ role: 'user', content: user }], max_tokens: 600, temperature: 0, thinkingFlag: false, stream: false });
    cost.judgeCredits += Number(data.credits_consumed ?? data.usage?.credits_consumed) || 0;
    cost.judgeIn += data.usage?.input_tokens ?? 0; cost.judgeOut += data.usage?.output_tokens ?? 0;
    text = (data.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
  }
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}
const latin = text => (text.match(/\b[A-Za-z]{3,}\b/g) ?? []).length;
const menu = text => /(?:^|\n)\s*(?:\d[.)]|[-•])\s+\S.*\n\s*(?:\d[.)]|[-•])\s+\S/u.test(text) || /что (?:вы )?(?:будете|будешь) делать/iu.test(text);
// Repetition across turns: the share of the reply's four-word runs that the last three assistant replies already used.
const runs = text => {
  const words = text.toLowerCase().replace(/ё/g, 'е').match(/\p{L}+/gu) ?? [];
  return words.slice(3).map((_, index) => words.slice(index, index + 4).join(' '));
};
function repeated(reply, history) {
  const seen = new Set(history.filter(message => message.role === 'assistant').slice(-3).flatMap(message => runs(message.content)));
  const own = runs(reply);
  return own.length ? own.filter(run => seen.has(run)).length / own.length : 0;
}
// «ты/вы»: how the character speaks to the hero in direct speech (lines after a dash).
function address(text) {
  const speech = (text.match(/—[^—*\n]{3,}/g) ?? []).join(' ');
  return { formal: (speech.match(/(?<!\p{L})(?:вы|вас|вам|вами|ваш\p{L}*)(?!\p{L})/giu) ?? []).length,
    informal: (speech.match(/(?<!\p{L})(?:ты|тебя|тебе|тобой|тво[йеяюи]\p{L}*)(?!\p{L})/giu) ?? []).length };
}
function addressShift(reply, history) {
  if (spec.cards[history.story]?.roleplayMode !== 'character') return false;
  const before = address(history.filter(message => message.role === 'assistant').map(message => message.content).join('\n'));
  const now = address(reply);
  const formal = before.formal >= before.informal;
  return formal ? now.informal >= 2 && now.informal > now.formal : now.formal >= 2 && now.formal > now.informal;
}
// Modern words that break a fantasy world (the world story only).
const ANACHRONISM = /(?<!\p{L})(?:электр\p{L}*|наэлектр\p{L}*|телефон\p{L}*|радио\p{L}*|компьютер\p{L}*|пластик\p{L}*|асфальт\p{L}*|бетон\p{L}*|стресс\p{L}*|адреналин\p{L}*|окей|о[’']кей|позитив\p{L}*|негатив\p{L}*|инфляц\p{L}*|алгоритм\p{L}*|процент\p{L}*|километр\p{L}*|сантиметр\p{L}*|миллиметр\p{L}*|килограмм\p{L}*|мегагерц\p{L}*|вольт\p{L}*|атом\p{L}*|молекул\p{L}*|вирус\p{L}*|бактери\p{L}*|гормон\p{L}*|рефлекс\p{L}*|режим\p{L}*|протокол\p{L}*|сканир\p{L}*|фокус\p{L}*|супер)(?!\p{L})/giu;
const anachronisms = (reply, story) => spec.cards[story].roleplayMode === 'world' ? (reply.match(ANACHRONISM) ?? []).map(word => word.toLowerCase()) : [];

// --rejudge: score the replies already in --out/results.json again (a changed rubric or judge), no chat calls.
const REJUDGE = process.argv.includes('--rejudge');
const results = REJUDGE ? JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')) : [];
const byId = Object.fromEntries(spec.cases.map(item => [item.id, item]));
async function score(row, history) {
  try { row.verdict = await judge(byId[row.case], history, row.user, row.reply); } catch (error) { row.verdict = { error: String(error.message ?? error) }; }
  process.stdout.write('.');
}
function measure(row, history, story) {
  history.story = story;
  Object.assign(row, { chars: row.reply.length, latin: latin(row.reply), menu: menu(row.reply), repeat: repeated(row.reply, history),
    addressShift: addressShift(row.reply, history), anachronisms: anachronisms(row.reply, story) });
}
if (REJUDGE) {
  for (const row of results) await score(row, row.context);
} else {
  for (const story of [...new Set(cases.map(item => item.story))]) {
    const history = await prefix(story);
    console.log(`prefix ${story}: ${history.length} messages`);
    for (const item of cases.filter(entry => entry.story === story)) {
      // A chain plays the next scenario turns one after another; only its last reply is judged.
      const users = item.chain ? scenario[story].slice(spec.prefixTurns, spec.prefixTurns + item.chain) : [item.user];
      for (const ref of VARIANTS) {
        for (let sample = 0; sample < SAMPLES; sample++) {
          const conversation = [...history];
          const chainRepeats = [];
          let row;
          for (const user of users) {
            const started = Date.now();
            const reply = await chat(chatMessages(ref, story, [...conversation, { role: 'user', content: user }], item.memory));
            row = { case: item.id, variant: ref, sample, ms: Date.now() - started, finish: reply.finish, user, reply: reply.text,
              context: conversation.slice(-6) };
            measure(row, conversation, story);
            chainRepeats.push(row.repeat);
            conversation.push({ role: 'user', content: user }, { role: 'assistant', content: reply.text });
          }
          if (item.chain) row.chainRepeat = chainRepeats.reduce((sum, value) => sum + value, 0) / chainRepeats.length;
          await score(row, row.context);
          results.push(row);
        }
      }
    }
  }
}
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 1));
console.log('\n');
const passed = (rows, criterion) => { const judged = rows.filter(row => row.verdict?.[criterion]); return judged.length ? `${judged.filter(row => !row.verdict[criterion].violated).length}/${judged.length}` : '-'; };
const avg = (rows, pick) => rows.length ? (rows.reduce((sum, row) => sum + pick(row), 0) / rows.length) : 0;
const pct = value => `${Math.round(value * 1000) / 10}%`;
for (const ref of [...new Set(results.map(row => row.variant))]) {
  const rows = results.filter(row => row.variant === ref);
  console.log(`${ref}: trap ${passed(rows, 'target')}, agency ${passed(rows, 'agency')}, score ${avg(rows.filter(row => row.verdict?.score), row => row.verdict.score).toFixed(2)}, chars ${Math.round(avg(rows, row => row.chars))}, ${Math.round(avg(rows, row => row.ms) / 100) / 10}s, repeat ${pct(avg(rows, row => row.chainRepeat ?? row.repeat))}, address shifts ${rows.filter(row => row.addressShift).length}, anachronisms ${rows.reduce((sum, row) => sum + (row.anachronisms?.length ?? 0), 0)}, latin ${rows.filter(row => row.latin).length}, menus ${rows.filter(row => row.menu).length}, judge errors ${rows.filter(row => row.verdict?.error).length}`);
  for (const id of [...new Set(rows.map(row => row.case))]) {
    const own = rows.filter(row => row.case === id);
    const extra = byId[id].chain ? `, chain repeat ${pct(avg(own, row => row.chainRepeat))}` : id.endsWith('short') ? `, chars ${own.map(row => row.chars).join('/')}` : '';
    console.log(`  ${id}: trap ${passed(own, 'target')}, agency ${passed(own, 'agency')}, score ${avg(own.filter(row => row.verdict?.score), row => row.verdict.score).toFixed(1)}${extra}${own.some(row => row.anachronisms?.length) ? `, anachronisms ${own.flatMap(row => row.anachronisms).join(',')}` : ''}`);
  }
}
console.log(`cost: chat $${((cost.chatIn * CHAT_PRICE[0] + cost.chatOut * CHAT_PRICE[1]) / 1e6).toFixed(3)} (${cost.chatIn}/${cost.chatOut} tokens), judge ≈ $${(cost.judgeCredits * 0.005 + (cost.judgeCredits ? 0 : (cost.judgeIn * JUDGE_PRICE[0] + cost.judgeOut * JUDGE_PRICE[1]) / 1e6)).toFixed(3)} (${cost.judgeIn}/${cost.judgeOut} tokens)`);
