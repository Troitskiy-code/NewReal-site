// Explicit, bounded live quality probe. Synthetic scenes only; never connects to the project database or TTS.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import dotenv from 'dotenv';

if (!process.argv.includes('--live')) {
  console.log('Use --live to send seven short synthetic scenes to the configured DeepInfra model. No database or TTS calls.');
  process.exit(0);
}
dotenv.config({ path: ['.env.local', '.env'], quiet: true });
if (!process.env.DEEPINFRA_API_KEY?.trim()) throw new Error('Missing configured DeepInfra key');
const require = createRequire(import.meta.url);
const root = process.cwd();
const cache = new Map();
function load(file) {
  file = resolve(file);
  if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} }; cache.set(file, mod.exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const dependency = name => {
    // Import only pure recognition code and transport; no project DB or metering writes.
    if (name === '@/lib/prisma') return { prisma: {} };
    if (name === '@/lib/logger') return { errorLog() {}, toSafeDiagnostic: () => ({}) };
    if (name === './aiCostTelemetry' || name === './aiProviders' || name === './chatThreads') return {};
    const base = name.startsWith('.') ? resolve(dirname(file), name) : null;
    if (!base) return require(name);
    return load(existsSync(base + '.ts') ? base + '.ts' : base);
  };
  new Function('require', 'module', 'exports', code)(dependency, mod, mod.exports);
  cache.set(file, mod.exports); return mod.exports;
}
const recognition = load('src/lib/speechRecognition.ts');
const { deepinfraFetch } = load('src/lib/deepinfraNetwork.ts');
const narrator = { id: 'narrator', name: '', kind: 'narrator', aliases: [] };
const main = { id: 'main', name: 'Алиса', kind: 'character', aliases: ['Alice'] };
const ivan = { id: 'npc:111111111111111111111111', name: 'Иван', kind: 'npc', aliases: [] };
const mira = { id: 'npc:222222222222222222222222', name: 'Мира', kind: 'npc', aliases: [] };
const group = [{ id: 'participant:bob', name: 'Борис', kind: 'participant', aliases: [] }, { id: 'participant:anna', name: 'Анна', kind: 'participant', aliases: [] }];
const scenes = [
  { id: 'single-with-npc', mode: 'character', speakers: [main], source: 'За окном шумит дождь.\nАлиса: «Ты вернулся!»\nИван, сосед, ответил: «Я обещал зайти».',
    expected: [['За окном шумит дождь.', 'narrator'], ['Ты вернулся!', 'main'], ['Я обещал зайти', 'Иван']] },
  { id: 'group', mode: 'group', speakers: group, source: 'В комнате погас свет.\nБорис: «Я проверю щиток».\nАнна: «Подожди меня».',
    expected: [['Я проверю щиток', 'participant:bob'], ['Подожди меня', 'participant:anna']] },
  { id: 'world', mode: 'world', speakers: [], source: 'Трактирщик Олег поставил кружку на стол.\n— Дорога закрыта, — сказал Олег.\n— Тогда останемся здесь, — ответила Мира.',
    expected: [['Дорога закрыта', 'Олег'], ['Тогда останемся здесь', 'Мира']] },
  { id: 'returning-npc-pronouns', mode: 'character', speakers: [main, ivan], recent: [{ role: 'assistant', content: 'Иван вошёл в комнату и снял мокрый плащ.' }],
    source: '— Я вернулся, — сказал он. Алиса улыбнулась. — Проходи, — ответила она.', expected: [['Я вернулся', ivan.id], ['Проходи', 'main']] },
  { id: 'ambiguous-voice', mode: 'character', speakers: [main], source: 'За дверью послышалось: «Не открывай».',
    expected: [['Не открывай', 'narrator', 'uncertain']] },
  { id: 'world-with-menu', mode: 'world', speakers: [mira], source: 'Лес затих.\nМира: «Дальше пойдём вместе».\nВыберите путь:\n1. Пещера — темно и опасно.\n2. Деревня — можно отдохнуть.',
    expected: [['Лес затих.', 'narrator'], ['Дальше пойдём вместе', mira.id]], excluded: ['Пещера', 'Деревня', 'Выберите'] },
  { id: 'english-single-with-npc', mode: 'character', speakers: [main], source: 'Alice: "Wait here."\nA courier named Leo said, "The bridge is closed."',
    expected: [['Wait here.', 'main'], ['The bridge is closed.', 'Leo']] },
];
const receipts = [];
for (const scene of scenes) {
  const context = { mode: scene.mode, messageId: scene.id, speakers: [narrator, ...scene.speakers], recent: scene.recent ?? [],
    character: { name: scene.mode === 'character' ? 'Алиса' : 'История', description: '', appearance: '', npcs: '' }, playerName: '' };
  const start = Date.now();
  try {
    const response = await deepinfraFetch('https://api.deepinfra.com/v1/openai/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.DEEPINFRA_API_KEY.trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506', temperature: 0, max_tokens: 4000,
        response_format: { type: 'json_object' }, messages: [{ role: 'system', content: recognition.SPEECH_RECOGNITION_PROMPT },
          { role: 'user', content: JSON.stringify({ ...context, source: scene.source }) }] }), signal: AbortSignal.timeout(55_000),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    if (data.choices?.[0]?.finish_reason !== 'stop') throw new Error('Incomplete response');
    const parsed = JSON.parse(data.choices[0].message.content);
    const result = recognition.validateSpeechRecognition(scene.source, parsed, context);
    const matched = scene.expected.every(([text, speaker, confidence]) => result.segments.some(segment => {
      const actor = result.speakers.find(item => item.id === segment.speakerId);
      return segment.text.includes(text) && (segment.speakerId === speaker || actor?.name === speaker)
        && (!confidence || segment.confidence === confidence);
    }));
    const noMenu = !(scene.excluded ?? []).some(word => result.segments.some(segment => segment.text.includes(word)));
    receipts.push({ scene: scene.id, passed: matched && noMenu, durationMs: Date.now() - start, usage: data.usage ?? null, result });
  } catch (error) {
    // Error messages contain only local validation or HTTP status, never credentials or provider response bodies.
    receipts.push({ scene: scene.id, passed: false, durationMs: Date.now() - start,
      error: error instanceof recognition.SpeechRecognitionError ? error.code : error instanceof Error && /^HTTP |^Incomplete/.test(error.message) ? error.message : 'transport_or_format' });
  }
  const last = receipts.at(-1);
  console.log(JSON.stringify({ scene: last.scene, passed: last.passed, durationMs: last.durationMs, error: last.error }));
}
const report = { date: '2026-11-03', syntheticOnly: true, databaseAccess: false, ttsCalls: 0,
  model: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506', passed: receipts.filter(item => item.passed).length, total: receipts.length, receipts };
writeFileSync(join(root, 'docs/scene-speaker-recognition-probe-2026-11-03.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, total: report.total }));
if (report.passed !== report.total) process.exitCode = 1;
