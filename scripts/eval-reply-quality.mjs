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
function chatMessages(ref, story, history) {
  const prompt = prompts[ref];
  const system = prompt.assembleRoleplayPrompt(spec.cards[story], 'ru', {}).content;
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
async function judge(item, history, reply) {
  const recent = history.slice(-6).map(message => `${message.role === 'user' ? 'ПОЛЬЗОВАТЕЛЬ' : 'АССИСТЕНТ'}: ${message.content.slice(0, 1500)}`).join('\n\n');
  const user = `Режим: ${spec.cards[item.story].roleplayMode}. Карточка: ${spec.cards[item.story].name}. Герой пользователя: ${spec.heroes[item.story]}.
Заметки к случаю: ${item.notes}
Вопрос проверки (target): ${item.check}

Последние сообщения истории:
${recent}

ПОСЛЕДНЕЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ: ${item.user}

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

// --rejudge: score the replies already in --out/results.json again (a changed rubric or judge), no chat calls.
const REJUDGE = process.argv.includes('--rejudge');
const results = REJUDGE ? JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')) : [];
const byId = Object.fromEntries(spec.cases.map(item => [item.id, item]));
async function score(row, history) {
  try { row.verdict = await judge(byId[row.case], history, row.reply); } catch (error) { row.verdict = { error: String(error.message ?? error) }; }
  process.stdout.write('.');
}
if (REJUDGE) {
  for (const row of results) await score(row, JSON.parse(readFileSync(join(outDir, `prefix-${byId[row.case].story}.json`), 'utf8')));
} else {
  for (const story of [...new Set(cases.map(item => item.story))]) {
    const history = await prefix(story);
    console.log(`prefix ${story}: ${history.length} messages`);
    for (const item of cases.filter(entry => entry.story === story)) {
      const trapHistory = [...history, { role: 'user', content: item.user }];
      for (const ref of VARIANTS) {
        for (let sample = 0; sample < SAMPLES; sample++) {
          const started = Date.now();
          const reply = await chat(chatMessages(ref, story, trapHistory));
          const row = { case: item.id, variant: ref, sample, ms: Date.now() - started, chars: reply.text.length, finish: reply.finish,
            latin: latin(reply.text), menu: menu(reply.text), reply: reply.text };
          await score(row, history);
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
for (const ref of [...new Set(results.map(row => row.variant))]) {
  const rows = results.filter(row => row.variant === ref);
  console.log(`${ref}: trap ${passed(rows, 'target')}, agency ${passed(rows, 'agency')}, score ${avg(rows.filter(row => row.verdict?.score), row => row.verdict.score).toFixed(2)}, chars ${Math.round(avg(rows, row => row.chars))}, ${Math.round(avg(rows, row => row.ms) / 100) / 10}s, latin ${rows.filter(row => row.latin).length}, menus ${rows.filter(row => row.menu).length}, judge errors ${rows.filter(row => row.verdict?.error).length}`);
  for (const id of [...new Set(rows.map(row => row.case))]) {
    const own = rows.filter(row => row.case === id);
    console.log(`  ${id}: trap ${passed(own, 'target')}, agency ${passed(own, 'agency')}, score ${avg(own.filter(row => row.verdict?.score), row => row.verdict.score).toFixed(1)}`);
  }
}
console.log(`cost: chat $${((cost.chatIn * CHAT_PRICE[0] + cost.chatOut * CHAT_PRICE[1]) / 1e6).toFixed(3)} (${cost.chatIn}/${cost.chatOut} tokens), judge ≈ $${(cost.judgeCredits * 0.005 + (cost.judgeCredits ? 0 : (cost.judgeIn * JUDGE_PRICE[0] + cost.judgeOut * JUDGE_PRICE[1]) / 1e6)).toFixed(3)} (${cost.judgeIn}/${cost.judgeOut} tokens)`);
