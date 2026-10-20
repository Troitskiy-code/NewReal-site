// TEMPORARY (2026-10-20): checks for the one-off embedding latency probe. No network, no database.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createModuleLoader } from './lib/memory-test-harness.mjs';
const require = createRequire(import.meta.url);
for (const key of Object.keys(process.env)) if (/^(DEEPINFRA_|ALLVPN_|LOGTAIL_)/.test(key)) delete process.env[key];
process.env.LOGTAIL_SOURCE_TOKEN = ''; process.env.LOGTAIL_INGESTING_HOST = '';
const forbidden = new Proxy({}, { get() { throw new Error('Database forbidden'); } });
const { root, load } = createModuleLoader({ prismaFor: () => forbidden });
const posts = [];
let respond = async () => ({ status: 200, data: { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 12, estimated_cost: 1.2e-7 } } });
const axios = require('axios');
axios.post = async (url, body, options) => {
  if (url !== 'https://api.deepinfra.com/v1/openai/embeddings') throw new Error('External network forbidden');
  posts.push({ url, body, options }); return respond(body, options);
};
const probe = load(join(root, 'src/lib/adminEmbeddingProbe.ts'));
probe.PROBE_LIMITS.roundPauseMs = 0;
let checks = 0;
async function check(label, fn) { await fn(); checks++; console.log(`PASS ${label}`); }
const httpError = status => Object.assign(new Error(`synthetic ${status}`), { isAxiosError: true, response: { status, headers: {}, data: {} } });
try {
  await check('probe refuses to start without a DeepInfra key', async () => {
    assert.throws(() => probe.reserveEmbeddingProbe(10), probe.EmbeddingProbeConfigurationError);
    assert.equal(probe.embeddingProbeStatus().configured, false);
  });
  process.env.DEEPINFRA_API_KEY = 'synthetic_di_key';
  await check('round count is bounded and must be an integer', async () => {
    for (const value of [9, 101, 10.5, '20', null]) assert.throws(() => probe.reserveEmbeddingProbe(value), probe.EmbeddingProbeConfigurationError);
  });
  await check('every round sends one request per allowlisted model, interleaved, with query formatting', async () => {
    const job = probe.reserveEmbeddingProbe(10);
    assert.throws(() => probe.reserveEmbeddingProbe(10), probe.EmbeddingProbeBusyError);
    await probe.executeEmbeddingProbe(job);
    assert.equal(job.state, 'finished'); assert.equal(posts.length, 10 * probe.EMBEDDING_PROBE_MODELS.length);
    assert.deepEqual([...new Set(posts.map(post => post.body.model))].sort(), [...probe.EMBEDDING_PROBE_MODELS].sort());
    assert.ok(posts.every(post => post.body.input.length === 1 && post.options.timeout === 15000 && post.options.signal && post.options.maxRedirects === 0));
    assert.ok(posts.every(post => post.options.headers.Authorization === 'Bearer synthetic_di_key'));
    const firstRound = posts.slice(0, probe.EMBEDDING_PROBE_MODELS.length).map(post => post.body.model);
    assert.equal(new Set(firstRound).size, probe.EMBEDDING_PROBE_MODELS.length);
    assert.match(posts.find(post => post.body.model.startsWith('Qwen/')).body.input[0], /^Instruct: .*\nQuery: /s);
    assert.match(posts.find(post => post.body.model.startsWith('intfloat/')).body.input[0], /^query: /);
    assert.doesNotMatch(posts.find(post => post.body.model === 'BAAI/bge-m3').body.input[0], /^(Instruct|query):/);
  });
  await check('status reports percentiles, thresholds, dimensions and cost but never the key', async () => {
    const status = probe.embeddingProbeStatus();
    const row = status.job.results[0];
    assert.equal(row.sent, 10); assert.equal(row.ok, 10); assert.equal(row.dimensions, 3); assert.equal(row.inputTokens, 120);
    assert.ok(Math.abs(row.providerCostUsd - 1.2e-6) < 1e-9); assert.equal(row.pctOver3s, 0); assert.equal(row.samplesMs.length, 10);
    assert.doesNotMatch(JSON.stringify(status), /synthetic_di_key/);
  });
  await check('an unknown model stops after three rejections; 429 and timeouts are counted, not hidden', async () => {
    const before = posts.length;
    respond = async (body) => {
      if (body.model === 'google/embeddinggemma-300m') throw httpError(404);
      if (body.model === 'BAAI/bge-m3') throw httpError(429);
      if (body.model === 'BAAI/bge-m3-multi') throw Object.assign(new Error('canceled'), { isAxiosError: true, code: 'ERR_CANCELED' });
      return { status: 200, data: { data: [{ index: 0, embedding: [1] }], usage: {} } };
    };
    const job = probe.reserveEmbeddingProbe(10); await probe.executeEmbeddingProbe(job);
    const rows = Object.fromEntries(probe.embeddingProbeStatus().job.results.map(row => [row.model, row]));
    assert.equal(rows['google/embeddinggemma-300m'].sent, 3); assert.equal(rows['google/embeddinggemma-300m'].otherErrors, 3);
    assert.equal(rows['BAAI/bge-m3'].sent, 10); assert.equal(rows['BAAI/bge-m3'].http429, 10); assert.equal(rows['BAAI/bge-m3'].pctOver5s, 100);
    assert.equal(rows['BAAI/bge-m3-multi'].timeouts, 10); assert.equal(rows['BAAI/bge-m3-multi'].p50, null);
    assert.equal(posts.length - before, 10 * (probe.EMBEDDING_PROBE_MODELS.length - 1) + 3);
  });
  await check('summary percentiles and slow-share thresholds use measured durations', async () => {
    const result = { model: 'x', dimensions: 1, inputTokens: 0, providerCostUsd: 0, errorCodes: {},
      samples: [100, 200, 300, 400, 1500, 3500, 6000].map(ms => ({ ms, outcome: 'ok', status: 200 })).concat([{ ms: 15000, outcome: 'timeout', status: null }]) };
    const row = probe.summarizeModel(result);
    assert.equal(row.p50, 400); assert.equal(row.max, 6000); assert.equal(row.pctOver1s, 50); assert.equal(row.pctOver3s, 37.5); assert.equal(row.pctOver5s, 25);
    assert.equal(row.samplesMs.at(-1), -15000);
  });
  console.log(`verify:embedding-probe: ${checks} passed`);
} catch (error) { console.error(error); process.exitCode = 1; }
