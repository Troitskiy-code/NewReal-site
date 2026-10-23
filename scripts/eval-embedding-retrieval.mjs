// Paid retrieval-quality comparison of DeepInfra embedding models on a synthetic Russian roleplay set.
// Spends a fraction of a cent: refuses to run without EMBEDDING_EVAL_CONFIRM=paid and an explicit
// DEEPINFRA_API_KEY in the process environment (.env is never read).
// Run: EMBEDDING_EVAL_CONFIRM=paid DEEPINFRA_API_KEY=... node scripts/eval-embedding-retrieval.mjs [--out file.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createModuleLoader } from './lib/memory-test-harness.mjs';

if (process.env['EMBEDDING_EVAL_CONFIRM'] !== 'paid' || !process.env['DEEPINFRA_API_KEY']?.trim()) {
  console.error('Refusing: set EMBEDDING_EVAL_CONFIRM=paid and DEEPINFRA_API_KEY to run this paid evaluation deliberately.');
  process.exit(2);
}
const key = process.env['DEEPINFRA_API_KEY'].trim();
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
const forbidden = new Proxy({}, { get() { throw new Error('Database forbidden'); } });
const { root, load } = createModuleLoader({ prismaFor: () => forbidden });
const { buildRagSearchQuery } = load(join(root, 'src/lib/ragRetrieval.ts'));
const spec = JSON.parse(readFileSync(join(root, 'docs/embedding-retrieval-eval-2026-10-20.json'), 'utf8'));

// Production query instruction for Qwen (embeddingClient.ts); documents are embedded as-is.
const QWEN_QUERY = 'Instruct: Given a question about a roleplay conversation, retrieve messages that contain the facts needed to answer it.\nQuery: ';
const MODELS = [
  { id: 'Qwen/Qwen3-Embedding-0.6B', query: q => QWEN_QUERY + q, doc: d => d },
  { id: 'BAAI/bge-m3', query: q => q, doc: d => d },
  { id: 'google/embeddinggemma-300m', query: q => `task: search result | query: ${q}`, doc: d => `title: none | text: ${d}` },
];

function buildStory(story, index) {
  let u = index * 5, a = index * 7;
  const messages = [];
  for (let pos = 1; pos <= story.length; pos++) {
    const keyed = story.keys[String(pos)];
    const role = pos % 2 === 1 ? 'user' : 'assistant';
    if (keyed && keyed.role !== role) throw new Error(`Role parity mismatch ${story.id}:${pos}`);
    const text = keyed?.text ?? (role === 'user' ? spec.userFillers[u++ % spec.userFillers.length] : spec.assistantFillers[a++ % spec.assistantFillers.length]);
    messages.push({ id: `${story.id}-${pos}`, role, content: text, tag: keyed?.tag ?? null });
  }
  return messages;
}

async function embed(model, inputs) {
  const vectors = [];
  for (let offset = 0; offset < inputs.length; offset += 32) {
    const batch = inputs.slice(offset, offset + 32);
    for (let attempt = 1; ; attempt++) {
      const response = await fetch('https://api.deepinfra.com/v1/openai/embeddings', { method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: batch, encoding_format: 'float' }), signal: AbortSignal.timeout(60_000) });
      if (response.ok) {
        const data = await response.json();
        const rows = [...data.data].sort((x, y) => x.index - y.index);
        if (rows.length !== batch.length) throw new Error(`Incomplete response from ${model}`);
        vectors.push(...rows.map(row => row.embedding));
        break;
      }
      if (attempt >= 3 || ![429, 500, 502, 503].includes(response.status)) throw new Error(`${model}: HTTP ${response.status}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  return vectors;
}
const cosine = (x, y) => { let dot = 0, nx = 0, ny = 0; for (let i = 0; i < x.length; i++) { dot += x[i] * y[i]; nx += x[i] ** 2; ny += y[i] ** 2; } return dot / Math.sqrt(nx * ny); };

const stories = spec.stories.map((story, index) => ({ ...story, messages: buildStory(story, index) }));
const report = { generatedAt: new Date().toISOString(), queries: stories.reduce((n, s) => n + s.queries.length, 0), models: [] };
for (const model of MODELS) {
  const perQuery = [];
  for (const story of stories) {
    const docs = await embed(model.id, story.messages.map(message => model.doc(message.content)));
    const queries = story.queries.map((item, i) => {
      // Same query composition as production: context only for referring questions.
      const history = [...story.messages, ...(item.context ?? []).map((content, j) => ({ id: `${story.id}-ctx-${i}-${j}`, role: j % 2 ? 'assistant' : 'user', content }))];
      return buildRagSearchQuery(item.q, [...history, { id: `${story.id}-q-${i}`, role: 'user', content: item.q }], `${story.id}-q-${i}`);
    });
    const queryVectors = await embed(model.id, queries.map(model.query));
    story.queries.forEach((item, i) => {
      const ranked = story.messages.map((message, j) => ({ tag: message.tag, score: cosine(queryVectors[i], docs[j]) }))
        .sort((x, y) => y.score - x.score);
      const goldRank = ranked.findIndex(row => item.gold.includes(row.tag)) + 1;
      const hardRank = (item.hard ?? []).length ? ranked.findIndex(row => item.hard.includes(row.tag)) + 1 : null;
      perQuery.push({ story: story.id, q: item.q, composedQuery: queries[i] !== item.q, goldRank, hardRank,
        hardAboveGold: hardRank !== null && hardRank < goldRank, top3: ranked.slice(0, 3).map(row => row.tag ?? 'filler') });
    });
  }
  const n = perQuery.length, at = k => Math.round(1000 * perQuery.filter(row => row.goldRank <= k).length / n) / 10;
  const withHard = perQuery.filter(row => row.hardRank !== null);
  report.models.push({ model: model.id, recallAt1: at(1), recallAt3: at(3), recallAt5: at(5), recallAt10: at(10),
    mrr: Math.round(1000 * perQuery.reduce((sum, row) => sum + 1 / row.goldRank, 0) / n) / 1000,
    hardQueries: withHard.length, hardAboveGold: withHard.filter(row => row.hardAboveGold).length, perQuery });
  console.log(`${model.id.padEnd(30)} R@1 ${at(1)}%  R@3 ${at(3)}%  R@5 ${at(5)}%  R@10 ${at(10)}%  MRR ${report.models.at(-1).mrr}  distractor above gold ${report.models.at(-1).hardAboveGold}/${withHard.length}`);
}
const [baseline, ...others] = report.models;
for (const other of others) {
  const diff = other.perQuery.map((row, i) => ({ q: `${row.story}: ${row.q}`, base: baseline.perQuery[i].goldRank, other: row.goldRank }))
    .filter(row => row.base !== row.other);
  console.log(`\n${other.model} vs ${baseline.model}: rank changes (baseline → candidate)`);
  for (const row of diff) console.log(`  ${row.base} → ${row.other}  ${row.q}`);
}
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
