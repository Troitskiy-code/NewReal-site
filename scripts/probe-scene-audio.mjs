// Two real Kie tasks at most; synthetic Russian dialogue. No application DB or quota calls.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import dotenv from 'dotenv';
if (!process.argv.includes('--live')) { console.log('Use --live for a resumable three-voice synthetic audio test (at most two Kie tasks). No DB access.'); process.exit(0); }
dotenv.config({ path: ['.env.local', '.env'], quiet: true });
if (!process.env.KIE_API_KEY?.trim()) throw new Error('Kie is not configured');
const require = createRequire(import.meta.url), modules = new Map();
const lame = await import('@breezystack/lamejs');
function load(file) {
  file = resolve(file); if (modules.has(file)) return modules.get(file);
  const mod = { exports: {} }; modules.set(file, mod.exports);
  const dependency = name => {
    if (name === '@breezystack/lamejs') return lame;
    if (name === '@/lib/prisma') return { prisma: new Proxy({}, { get() { throw new Error('Probe must never use the project database'); } }) };
    if (name.endsWith('aiCostTelemetry')) return {};
    const base = name.startsWith('@/') ? resolve('src', name.slice(2)) : name.startsWith('.') ? resolve(dirname(file), name) : null;
    return base ? load(existsSync(base + '.ts') ? base + '.ts' : base + '.js') : require(name);
  };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', code)(dependency, mod, mod.exports);
  modules.set(file, mod.exports); return mod.exports;
}
const provider = load('src/lib/speechProvider.ts');
const { sceneSpeechBatches } = load('src/lib/sceneSpeechJobs.ts');
const { speechPcmToMp3 } = load('src/lib/speechAudio.ts');
const turns = [
  { speakerId: 'anna', voice: 'Aoede', speaker: 'character', text: 'Я ждала тебя.', style: 'Delivery: warm and tender.' },
  { speakerId: 'boris', voice: 'Fenrir', speaker: 'character', text: 'Я обещал вернуться.', style: 'Delivery: firm and confident.' },
  { speakerId: 'kira', voice: 'Kore', speaker: 'character', text: 'Тогда идём вместе.', style: 'Delivery: cheerful and happy.' },
  { speakerId: 'anna', voice: 'Aoede', speaker: 'character', text: 'Хорошо, идём.', style: 'Delivery: warm and tender.' },
];
const batches = sceneSpeechBatches(turns), model = provider.SPEECH_EXPRESSIVE_MODEL;
if (batches.length !== 2) throw new Error('Expected exactly two bounded tasks');
const directory = resolve('.runtime/scene-audio-probe'); mkdirSync(directory, { recursive: true });
const statePath = resolve(directory, 'state.json'), audioPath = resolve(directory, 'three-voices.mp3');
const hash = createHash('sha256').update(JSON.stringify([model, batches])).digest('hex');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { hash, model, parts: batches.map(() => ({ phase: 'idle' })) };
if (state.hash !== hash) throw new Error('An existing probe has another script; refusing a new purchase');
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
const pcm = [];
try {
  for (const [index, batch] of batches.entries()) {
    const part = state.parts[index];
    if (!part.taskId) {
      if (part.phase !== 'idle') throw new Error('A previous submission has no task id; automatic resubmission is blocked');
      part.phase = 'submitting'; save();
      part.taskId = await provider.submitSceneSpeech(batch, model); part.phase = 'pending'; save();
    }
    const deadline = Date.now() + 180_000;
    for (;;) {
      const task = await provider.getSpeechTask(part.taskId, model);
      part.credits = task.credits; save();
      if (task.state === 'failed') { part.phase = 'failed'; save(); throw new Error('Provider task failed; no automatic new purchase'); }
      if (task.state === 'ready') {
        pcm.push(await provider.downloadSpeechPcm(task.url)); part.phase = 'ready'; save(); break;
      }
      if (Date.now() >= deadline) throw new Error('Task is still pending; rerun to resume its task id');
      await new Promise(done => setTimeout(done, 4000));
    }
    console.log(JSON.stringify({ part: index + 1, phase: part.phase, credits: part.credits }));
  }
  writeFileSync(audioPath, await speechPcmToMp3(Buffer.concat([pcm[0], Buffer.alloc(4800), pcm[1]])));
  const report = { date: '2026-11-04', syntheticOnly: true, databaseAccess: false, taskCount: 2, model, turns,
    reportedCredits: state.parts.reduce((sum, part) => sum + (part.credits ?? 0), 0), audioPath, parts: state.parts };
  writeFileSync('docs/scene-audio-probe-2026-11-04.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, taskCount: 2, reportedCredits: report.reportedCredits, audioPath }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, reason: error instanceof provider.SpeechProviderError ? error.reason : error.message }));
  process.exitCode = 1;
}
