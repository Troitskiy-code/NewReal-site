// Three paid extraction calls on synthetic turns and a disposable database.
// node scripts/eval-memory-v2.mjs --paid [--out docs/memory-v2-live-2026-10-18.json]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { startHarness } from './lib/memory-test-harness.mjs';
if (!process.argv.includes('--paid')) throw new Error('Requires --paid: at most three paid DeepInfra extraction calls.');
let env = {};
for (const path of ['.env', '.env.local']) if (existsSync(path)) Object.assign(env, parse(readFileSync(path)));
const key = process.env.DEEPINFRA_API_KEY || env.DEEPINFRA_API_KEY;
if (!key) throw new Error('No DeepInfra key');
const liveFetch = globalThis.fetch;
const h = await startHarness({ label: 'memory-v2-live' });
process.env.MEMORY_V2_ENABLED = '1'; process.env.MEMORY_AI_PROVIDER = 'deepinfra'; process.env.DEEPINFRA_API_KEY = key;
const memory = h.load(join(h.root, 'src/lib/memoryV2.ts'));
const post = h.provider.axiosPost.bind(h.provider);
const usage = [];
h.provider.axiosPost = async (url, body) => {
  if (h.provider.kindOf(body) !== 'memory_extract') return post(url, body);
  if (usage.length >= 3) throw new Error('Live call budget exceeded');
  const response = await liveFetch('https://api.deepinfra.com/v1/openai/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(40_000),
  });
  if (!response.ok) throw Object.assign(new Error(`Provider HTTP ${response.status}`), { __noRetry: true });
  const data = await response.json(); usage.push({ usage: data.usage, raw: data.choices?.[0]?.message?.content });
  return { status: response.status, data, headers: {} };
};
const turns = [
  { user: 'Меня зовут Артём. Я живу в Казани.', reply: 'Меня зовут Лира. Я люблю музыку.' },
  { user: 'Моё настоящее имя — Никита. Я работаю врачом.', reply: 'Рада знакомству, Никита.' },
  { user: 'Я больше не работаю врачом.', reply: 'Поняла тебя.' },
];
const report = [];
let failed = false;
try {
  await h.helpers.model(16_000);
  const user = await h.helpers.user('story'), character = await h.helpers.character(user.id);
  const scope = await h.helpers.scope(user.id, character.id);
  for (const turn of turns) {
    const rows = await h.helpers.messages(user.id, character.id, [{ role: 'user', content: turn.user }, { role: 'assistant', content: turn.reply }], { embed: false });
    const job = await h.db.$transaction(async tx => {
      const job = await memory.enqueueMemoryTurn(tx, scope, rows[0].id);
      await memory.finishMemoryTurn(tx, rows[0].id, rows[1].id); return job;
    });
    await memory.drainMemoryJobs({ threadId: scope.threadId, limit: 1 });
    const saved = await h.db.memoryJob.findUnique({ where: { id: job.id } });
    const active = await h.db.memoryFact.findMany({ where: { threadId: scope.threadId, status: 'active' }, select: { subject: true, key: true, value: true } });
    report.push({ turn, status: saved.status, errorCode: saved.errorCode, active });
    console.log(JSON.stringify(report.at(-1)));
  }
  const sourceHistory = await h.db.memoryFact.findMany({ where: { threadId: scope.threadId }, select: { subject: true, key: true, value: true, status: true } });
  const result = { provider: 'deepinfra', model: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506', report, sourceHistory, usage };
  if (process.argv.includes('--out')) writeFileSync(process.argv[process.argv.indexOf('--out') + 1], `${JSON.stringify(result, null, 2)}\n`);
  const final = report.at(-1)?.active ?? [];
  failed = report.some(row => row.status !== 'succeeded') || !final.some(fact => fact.subject === 'user' && fact.key === 'name' && fact.value === 'Никита')
    || final.some(fact => fact.key === 'occupation') || !final.some(fact => fact.subject === 'character' && fact.value === 'Лира')
    || !final.some(fact => fact.subject === 'user' && fact.key === 'city' && fact.value === 'Казань');
} finally { delete process.env.MEMORY_V2_ENABLED; await h.stop(); }
if (failed) process.exitCode = 1;
