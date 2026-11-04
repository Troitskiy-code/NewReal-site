// Explicit live check of text selection. Synthetic inputs only; never opens the project database or calls TTS.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import dotenv from 'dotenv';

if (!process.argv.includes('--live')) { console.log('Use --live for 16 synthetic DeepInfra preparation checks; --baseline tests the old prompt on three scenes. No DB or TTS.'); process.exit(0); }
dotenv.config({ path: ['.env.local', '.env'], quiet: true });
if (!process.env.DEEPINFRA_API_KEY?.trim()) throw new Error('DeepInfra is not configured');
const baseline = process.argv.includes('--baseline');
const require = createRequire(import.meta.url), cache = new Map();
function load(file) {
  file = resolve(file); if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} }; cache.set(file, mod.exports);
  let source = readFileSync(file, 'utf8');
  if (baseline && file.endsWith('speechPreparation.ts')) {
    const old = spawnSync('git', ['show', 'e504c89:src/lib/speechPreparation.ts'], { encoding: 'utf8', windowsHide: true });
    if (old.status !== 0) throw new Error('Cannot load the recorded baseline');
    source = old.stdout;
  }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const dependency = name => {
    if (name === './aiCostTelemetry' || name === './aiProviders') return {};
    const base = name.startsWith('.') ? resolve(dirname(file), name) : null;
    return base ? load(existsSync(base + '.ts') ? base + '.ts' : base) : require(name);
  };
  new Function('require', 'module', 'exports', code)(dependency, mod, mod.exports); cache.set(file, mod.exports); return mod.exports;
}
const preparation = load('src/lib/speechPreparation.ts');
const { deepinfraFetch } = load('src/lib/deepinfraNetwork.ts');
const city = 'Вечер медленно опускался на город. Алиса закрыла окно и присела рядом.';
const cases = [
  ['character-narration-only', 'dialogue', city, ''],
  ['character-second-person-narration', 'dialogue', 'Ты входишь в комнату. За окном шумит дождь. Алиса поворачивается к тебе.', ''],
  ['character-narration-with-speech', 'dialogue', 'В комнате потемнело. Алиса отложила книгу. «Я ждала тебя. Как прошёл день?» — спросила она.', 'Я ждала тебя. Как прошёл день?'],
  ['character-unmarked-speech', 'dialogue', 'Я рада тебя видеть. Расскажи, как прошёл день.', 'Я рада тебя видеть. Расскажи, как прошёл день.'],
  ['character-indirect-speech', 'dialogue', 'Алиса сказала, что вернётся завтра, и ушла.', ''],
  ['character-first-person-stage-action', 'dialogue', '*Я медленно подошла к окну и молча посмотрела на улицу.*', ''],
  ['character-internal-thought', 'dialogue', 'Алиса подумала: «Лучше промолчать». Она не произнесла ни слова.', ''],
  ['character-reading-aloud', 'dialogue', 'Алиса развернула письмо и прочитала вслух: «Встреча 3 ноября в 19:30, цена 2 500 рублей».', 'Встреча 3 ноября в 19:30, цена 2 500 рублей'],
  ['character-speech-about-action', 'dialogue', '«Я улыбнулась, чтобы тебя успокоить», — сказала Алиса.', 'Я улыбнулась, чтобы тебя успокоить'],
  ['character-and-incidental-npc', 'dialogue', 'Раздался стук. Алиса сказала: «Входи». Иван ответил: «Спасибо».', 'Входи Спасибо'],
  ['world-narration-only', 'scene', city, city],
  ['group-narration-and-dialogue', 'dialogue', 'По всему зданию зазвучал сигнал тревоги. Борис: «Нужно уходить». Анна: «Я с тобой».', 'Нужно уходить Я с тобой'],
  ['character-choice-menu', 'dialogue', '«Пойдём вместе?» — спросила Алиса.\nВыберите путь:\n1. Пещера — темно и опасно.\n2. Деревня — можно отдохнуть.', 'Пойдём вместе?'],
  ['character-english-narration', 'dialogue', 'Alice closed the window and sat down beside you. The room grew quiet.', ''],
  ['character-english-unmarked-speech', 'dialogue', 'I missed you. Would you like some tea?', 'I missed you. Would you like some tea?'],
  ['character-quoted-sign', 'dialogue', 'На вывеске написано «Добро пожаловать». Алиса молча смотрит на дверь.', ''],
];
const caseFilter = process.argv.find(arg => arg.startsWith('--case='))?.slice(7).split(',');
const selected = caseFilter ? cases.filter(item => caseFilter.includes(item[0])) : baseline ? cases.filter(item => ['character-narration-only', 'character-narration-with-speech', 'world-narration-only'].includes(item[0])) : cases;
const receipts = [];
for (const [name, speechMode, source, expected] of selected) {
  const started = Date.now();
  let candidate;
  try {
    const response = await deepinfraFetch('https://api.deepinfra.com/v1/openai/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.DEEPINFRA_API_KEY.trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: preparation.SPEECH_PREPARATION_MODEL, temperature: 0, max_tokens: 4000,
        response_format: { type: 'json_object' }, messages: [{ role: 'system', content: baseline ? preparation.SPEECH_PREPARATION_PROMPT : preparation.speechPreparationPrompt(speechMode) },
          { role: 'user', content: JSON.stringify({ speechMode, character: { name: 'Алиса', personality: 'Добрая и спокойная девушка', appearance: '' }, source }) }] }), signal: AbortSignal.timeout(50_000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    if (data.choices?.[0]?.finish_reason !== 'stop') throw new Error('Incomplete response');
    const parsed = JSON.parse(data.choices[0].message.content); candidate = parsed;
    const result = preparation.validateSpeechPerformance(source, baseline ? parsed : preparation.repairSpeechQuoteBoundaries(source, parsed), baseline ? undefined : speechMode);
    const words = text => text.replace(/[«»“”"]/g, '');
    receipts.push({ name, speechMode, source, expected, spoken: result.text, passed: words(result.text) === words(expected),
      durationMs: Date.now() - started, usage: data.usage ?? null });
  } catch (error) {
    receipts.push({ name, speechMode, passed: false, durationMs: Date.now() - started, candidate,
      error: error instanceof preparation.SpeechPreparationError ? error.reason : error instanceof Error && /^HTTP |^Incomplete/.test(error.message) ? error.message : 'transport_or_format' });
  }
  const last = receipts.at(-1); console.log(JSON.stringify({ name, passed: last.passed, spoken: last.spoken, error: last.error }));
}
const report = { date: '2026-11-03', baseline, syntheticOnly: true, databaseAccess: false, ttsCalls: 0,
  passed: receipts.filter(item => item.passed).length, total: receipts.length, receipts };
writeFileSync('docs/speech-selection-' + (baseline ? 'baseline-' : caseFilter ? 'focused-' : '') + '2026-11-03.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, total: report.total }));
if (report.passed !== report.total) process.exitCode = 1;
