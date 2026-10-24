// Paid comparison of summary models on one real story, run through the production rebuild path:
// the same chunking, prompts, JSON schema, renderer/validator and chunk backoff; only the model changes.
// node scripts/eval-summary-models.mjs --paid --story <story.json> --out <dir> [--models id,id] [--budget 1500] [--steps N]
// <story.json> is {chat:{messages,character}, memory:{core}} as the chat and memory APIs return them.
// Keys come from .env.local (DEEPINFRA_API_KEY, KIE_API_KEY). Story text and summaries are written only to
// --out; the console gets counts, timings and costs.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { createModuleLoader } from './lib/memory-test-harness.mjs';

const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
if (!process.argv.includes('--paid')) throw new Error('Live evaluation requires --paid; it calls paid text providers.');
const storyPath = arg('--story'), outDir = arg('--out');
if (!storyPath || !outDir) throw new Error('--story and --out are required');
const config = { ...process.env };
for (const file of ['.env', '.env.local']) if (existsSync(file)) Object.assign(config, parse(readFileSync(file)));

const { root, load } = createModuleLoader({ prismaFor: () => { throw new Error('Database forbidden'); } });
const evidence = load(join(root, 'src/lib/memorySummaryEvidence.ts'));
const policy = load(join(root, 'src/lib/memorySummaryPolicy.ts'));
const { countTokens } = load(join(root, 'src/lib/tokenCount.ts'));
const chapterModule = load(join(root, 'src/lib/memorySummaryChapters.ts'));
// chapters (production since 2026-10-24) or merge (every step re-tells the past; the earlier path).
const STRUCTURE = arg('--structure') ?? 'chapters';
if (!['chapters', 'merge'].includes(STRUCTURE)) throw new Error('--structure is chapters or merge');

// Prices in USD per 1M tokens (DeepInfra catalog 2026-10-11; kie.ai/pricing 2026-10-24).
const MODELS = {
  'di-mistral-small': { provider: 'deepinfra', model: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506', price: [0.075, 0.2] },
  'di-gemma4-turbo': { provider: 'deepinfra', model: 'google/gemma-4-31B-it-turbo', price: [0.09, 0.34] },
  'di-qwen3-235b': { provider: 'deepinfra', model: 'Qwen/Qwen3-235B-A22B-Instruct-2507', price: [0.09, 0.55] },
  'di-deepseek-v4-flash': { provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V4-Flash-0731', price: [0.06, 0.18] },
  'di-deepseek-v4.1-flash': { provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V4.1-Flash', price: [0.2, 0.6] },
  'di-mimo-flash': { provider: 'deepinfra', model: 'XiaomiMiMo/MiMo-V2.6-Flash', price: [0.14, 0.28] },
  'kie-gpt6-luna': { provider: 'kie-responses', path: '/codex/v1/responses', model: 'gpt-6-luna', price: [0.03, 0.15], effort: 'low' },
  'kie-deepseek-v4.1-flash': { provider: 'kie-responses', path: '/openai/v1/responses', model: 'deepseek-v4-1-flash', price: [0.12, 0.475], effort: 'none' },
  'kie-claude-haiku-5.5': { provider: 'kie-claude', model: 'claude-haiku-5-5', price: [0.06, 0.3] },
  'kie-gemini-3.8-flash': { provider: 'kie-gemini', path: '/gemini-3-8-flash-openai/v1/chat/completions', price: [0.225, 1.125] },
};
const chosen = (arg('--models') ?? Object.keys(MODELS).join(',')).split(',');
for (const id of chosen) if (!MODELS[id]) throw new Error(`Unknown model ${id}`);

// Rebuild limits copied from src/lib/chatMemory.ts; prompts come from memorySummaryChapters.
// --single: the whole summarizable story in one call (experiment, not the production bound).
const SINGLE = process.argv.includes('--single');
const KEEP_RECENT = 25, MAX_CHUNK = SINGLE ? 10_000 : 120, MAX_INPUT = SINGLE ? 60_000 : 12_000, TIMEOUT_MS = SINGLE ? 240_000 : 90_000;
const BACKOFF = new Set(['MEMORY_SUMMARY_TRUNCATED', 'MEMORY_SUMMARY_NO_FITTING_SOURCE']);
const tooLarge = (input, limit = MAX_INPUT) => input.length > limit * 8 || countTokens(input) > limit;
const time = row => new Date(row.createdAt).getTime();
const mergeSources = (old, messages) => [...evidence.sourcesFromSummaries(old), ...evidence.makeSummarySources(messages)]
  .map((source, index) => ({ ...source, id: `s${index + 1}` }));

class StepError extends Error { constructor(code, extra = {}) { super(code); this.code = code; Object.assign(this, extra); } }
const unfence = text => {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
};
/** One model call, answered in the chat-completions shape readSummaryResponse expects. */
async function callModel(spec, system, user, maxTokens, sourceIds) {
  const limit = policy.summaryGenerationLimit(maxTokens);
  const format = policy.groundedSummaryFormat(sourceIds, maxTokens);
  let url, headers, body;
  if (spec.provider === 'deepinfra') {
    url = 'https://api.deepinfra.com/v1/openai/chat/completions';
    headers = { Authorization: `Bearer ${config.DEEPINFRA_API_KEY}` };
    body = { model: spec.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: limit, response_format: format, temperature: 0 };
  } else {
    headers = { Authorization: `Bearer ${config.KIE_API_KEY}` };
    if (spec.provider === 'kie-gemini') {
      url = `https://api.kie.ai${spec.path}`;
      body = { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false,
        reasoning_effort: 'low', include_thoughts: false, max_tokens: limit, response_format: format, temperature: 0 };
    } else if (spec.provider === 'kie-responses') {
      url = `https://api.kie.ai${spec.path}`;
      body = { model: spec.model, stream: false, reasoning: { effort: spec.effort },
        input: [{ role: 'system', content: system }, { role: 'user', content: user }],
        text: { format: { type: 'json_schema', name: format.json_schema.name, strict: true, schema: format.json_schema.schema } },
        ...(spec.model.startsWith('deepseek') ? {} : { max_output_tokens: limit }) };
    } else {
      url = 'https://api.kie.ai/claude/v1/messages';
      body = { model: spec.model, system, messages: [{ role: 'user', content: user }], max_tokens: limit,
        temperature: 0, thinkingFlag: false, stream: false };
    }
  }
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new StepError(error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', { ms: Date.now() - started });
  }
  const ms = Date.now() - started;
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new StepError(`HTTP_${response.status}_NON_JSON`, { ms }); }
  if (!response.ok || (data.code !== undefined && data.code !== 200 && !data.choices && !data.output && !data.content)) {
    throw new StepError(`HTTP_${response.status}_${data.code ?? ''}`, { ms, providerMessage: String(data.msg ?? data.error?.message ?? data.detail ?? '').slice(0, 200) });
  }
  if (data.data && !data.choices && !data.output && !data.content) data = data.data;
  let text = '', finish = 'stop', input = 0, output = 0, reasoning = 0;
  if (spec.provider === 'deepinfra' || spec.provider === 'kie-gemini') {
    const choice = data.choices?.[0];
    text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    finish = choice?.finish_reason ?? 'other';
    input = data.usage?.prompt_tokens ?? 0; output = data.usage?.completion_tokens ?? 0;
    reasoning = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  } else if (spec.provider === 'kie-responses') {
    text = data.output_text ?? (data.output ?? []).flatMap(item => item.content ?? [])
      .filter(part => part.type === 'output_text').map(part => part.text).join('');
    finish = data.status === 'incomplete' ? 'length' : 'stop';
    input = data.usage?.input_tokens ?? 0; output = data.usage?.output_tokens ?? 0;
    reasoning = data.usage?.output_tokens_details?.reasoning_tokens ?? 0;
  } else {
    text = unfence((data.content ?? []).filter(part => part.type === 'text').map(part => part.text).join(''));
    finish = data.stop_reason === 'max_tokens' ? 'length' : 'stop';
    input = data.usage?.input_tokens ?? 0; output = data.usage?.output_tokens ?? 0;
  }
  const usage = { ms, input, output, reasoning, credits: Number(data.credits_consumed ?? data.usage?.credits_consumed) || null };
  try {
    return { ...policy.readSummaryResponse({ choices: [{ finish_reason: finish, message: { content: text } }] }), usage };
  } catch (error) { throw new StepError(error.code ?? 'READ_FAILED', { usage }); }
}

async function runModel(id, messages, core, names, maxTokens) {
  const spec = MODELS[id], calls = [], steps = [];
  const record = (entry) => { calls.push(entry); };
  /** One provider answer for `mode`; transport failures are retried like the user's rebuild loop would. */
  async function ask(mode, input, budget, sourceIds) {
    if (tooLarge(input)) throw new StepError('INPUT_TOO_LARGE');
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const answer = await callModel(spec, chapterModule.summarySystemPrompt(mode, budget, names), input, budget, sourceIds);
        record({ ...answer.usage, mode, finish: answer.finishReason, ok: true, raw: answer.text,
          ...(process.argv.includes('--keep-input') ? { request: input } : {}) });
        return answer.text;
      } catch (error) {
        record({ ...(error.usage ?? { ms: error.ms ?? 0 }), mode, error: error.code ?? String(error), providerMessage: error.providerMessage });
        // Transport failures are retried like the user's rebuild loop would; content failures repeat at temperature 0.
        if (!/^(TIMEOUT|NETWORK|HTTP_5|HTTP_429)/.test(error.code ?? '')) throw error;
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 15_000 * (attempt + 1)));
      }
    }
    throw lastError;
  }
  /** Render statistics belong to the call that produced them (the last recorded one). */
  const diagnose = stats => { const last = calls.at(-1); if (last) last.stats = stats; };
  async function step(draft, part) {
    if (STRUCTURE === 'chapters') {
      return chapterModule.writeSummaryChapter(draft, part, { maxTokens, core, names, countTokens, ask, diagnose },
        stats => { const last = calls.at(-1); if (last) last.chapters = stats; });
    }
    const sources = mergeSources(draft, part);
    if (!sources.length) throw new StepError('MEMORY_SUMMARY_NO_FITTING_SOURCE');
    const raw = await ask(draft ? 'merge' : 'summary', JSON.stringify({ sources, core }), maxTokens, sources.map(source => source.id));
    const summary = evidence.renderGroundedSummary(raw, sources, maxTokens, countTokens, diagnose, core ?? '', names);
    if (!summary) { calls.at(-1).ok = false; throw new StepError('MEMORY_SUMMARY_NO_FITTING_SOURCE'); }
    return summary;
  }
  const olderHalf = rows => {
    let end = Math.ceil(rows.length / 2);
    while (end > 0 && end < rows.length && time(rows[end - 1]) === time(rows[end])) end -= 1;
    return rows.slice(0, end);
  };
  let draft = '', index = 0;
  const stepLimit = Number(arg('--steps') ?? Infinity);
  while (index < messages.length && steps.length < stepLimit) {
    let rows = messages.slice(index, index + MAX_CHUNK + 1);
    let end = Math.min(rows.length, MAX_CHUNK);
    while (end > 0 && end < rows.length && time(rows[end - 1]) === time(rows[end])) end -= 1;
    let chunk = rows.slice(0, end);
    const fits = candidate => !tooLarge(JSON.stringify(mergeSources(draft, candidate)), MAX_INPUT - 2000);
    while (chunk.length && !fits(chunk)) { const last = time(chunk.at(-1)); chunk = chunk.filter(row => time(row) !== last); }
    if (!chunk.length) throw new Error('A single timestamp group exceeds the input bound; clipping is not reproduced here.');
    const entry = { from: index, offered: chunk.length, attempts: [] };
    let part = chunk, summary = null;
    for (;;) {
      try { summary = await step(draft, part); entry.attempts.push('ok'); break; } catch (error) {
        entry.attempts.push(error.code ?? String(error));
        if (!BACKOFF.has(error.code)) { entry.fatal = error.code ?? String(error); break; }
        const half = olderHalf(part);
        if (half.length && half.length < part.length) { part = half; continue; }
        entry.skipped = true; break;
      }
    }
    if (entry.fatal) { entry.skipped = true; part = chunk; }
    entry.used = part.length;
    if (summary) draft = summary;
    index += part.length;
    steps.push(entry);
    console.log(JSON.stringify({ model: id, processed: index, total: messages.length, attempts: entry.attempts, skipped: Boolean(entry.skipped) }));
  }
  const sum = key => calls.reduce((total, call) => total + (Number(call[key]) || 0), 0);
  const cost = (sum('input') * spec.price[0] + sum('output') * spec.price[1]) / 1e6;
  const latencies = calls.map(call => call.ms).filter(Boolean).sort((a, b) => a - b);
  const pick = q => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : null;
  const rejected = calls.reduce((total, call) => total + (call.stats?.rejectedSentenceCount ?? 0), 0);
  const compressions = calls.filter(call => call.mode === 'compress').length;
  return { id, model: spec.model ?? spec.path, provider: spec.provider, summary: draft, steps, calls,
    totals: { calls: calls.length, failedCalls: calls.filter(call => call.error || !call.ok).length,
      skippedSteps: steps.filter(step => step.skipped).length, inputTokens: sum('input'), outputTokens: sum('output'),
      reasoningTokens: sum('reasoning'), costUsd: Number(cost.toFixed(5)), p50ms: pick(0.5), p90ms: pick(0.9), maxMs: latencies.at(-1) ?? null,
      rejectedSentences: rejected, compressionCalls: compressions,
      chapters: evidence && STRUCTURE === 'chapters' ? chapterModule.splitSummaryChapters(draft).chapters.length : null, summaryChars: draft.length, summaryTokens: countTokens(draft) } };
}

const story = JSON.parse(readFileSync(storyPath, 'utf8'));
const all = story.chat.messages.map(row => ({ role: row.role, content: row.content, createdAt: row.createdAt }))
  .sort((a, b) => time(a) - time(b));
// The rebuild leaves the newest 25 messages out and never splits a timestamp group.
let through = all.length - KEEP_RECENT;
while (through > 0 && time(all[through - 1]) === time(all[through])) through -= 1;
const messages = all.slice(0, through);
const core = story.memory?.core?.content?.trim() || null;
const fromCore = evidence.participantNames(core ?? '');
const short = name => name && name.trim().length <= 30 ? name.trim() : undefined;
const names = { user: short(fromCore.user), character: short(fromCore.character ?? story.chat.character?.name) };
const maxTokens = Number(arg('--budget') ?? 1500);
mkdirSync(outDir, { recursive: true });
console.log(JSON.stringify({ summarizable: messages.length, total: all.length, names: { user: Boolean(names.user), character: Boolean(names.character) }, maxTokens, models: chosen }));
const results = await Promise.all(chosen.map(id => runModel(id, messages, core, names, maxTokens)
  .catch(error => ({ id, crashed: String(error?.message ?? error) }))));
for (const result of results) {
  writeFileSync(join(outDir, `${result.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
  if (result.summary) writeFileSync(join(outDir, `${result.id}.md`), `${result.summary}\n`);
  // The last answer before the renderer, to tell model output apart from what the validator kept.
  const raw = result.calls?.filter(call => call.raw).at(-1)?.raw;
  if (raw) {
    let items = [];
    try { items = JSON.parse(raw).items ?? []; } catch { /* unparsable answers stay in the JSON report */ }
    if (items.length) writeFileSync(join(outDir, `${result.id}.raw.txt`), `${items.map(item => `- [${item.section}] ${item.text}`).join('\n')}\n`);
  }
  console.log(JSON.stringify({ model: result.id, crashed: result.crashed, ...result.totals }));
}
