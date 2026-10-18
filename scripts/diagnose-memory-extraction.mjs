// Read-only replay of an operator-provided private input. Never connects to a DB,
// changes a queue or writes quotes/model output into its report. Up to two paid calls.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { createModuleLoader } from './lib/memory-test-harness.mjs';
const arg = name => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--paid') || !process.argv.includes('--input') || !process.argv.includes('--out')) {
  throw new Error('Requires --paid --input <private JSON> --out <metadata report> [--calls 1|2]');
}
const calls = process.argv.includes('--calls') ? Number(arg('--calls')) : 1;
if (![1, 2].includes(calls)) throw new Error('At most two paid calls');
let environment = {};
for (const path of ['.env', '.env.local']) if (existsSync(path)) Object.assign(environment, parse(readFileSync(path)));
const apiKey = process.env.DEEPINFRA_API_KEY || environment.DEEPINFRA_API_KEY;
if (!apiKey) throw new Error('DeepInfra key is not configured');
const privateInput = JSON.parse(readFileSync(arg('--input'), 'utf8'));
if (!Array.isArray(privateInput.messages) || !Array.isArray(privateInput.activeFacts)) throw new Error('Invalid input shape');
const forbidden = new Proxy({}, { get() { throw new Error('Database forbidden'); } });
const { load, root } = createModuleLoader({ prismaFor: () => forbidden });
const memory = load(join(root, 'src/lib/memoryFacts.ts'));
const { deepinfraGenerationOptions } = load(join(root, 'src/lib/deepinfraModels.ts'));
const sources = memory.factSources(privateInput.messages);
const input = JSON.stringify({ sources, activeFacts: privateInput.activeFacts });
if (input.length > 64000) throw new Error('Input exceeds the production limit');
const model = 'mistralai/Mistral-Small-3.2-24B-Instruct-2506';
const report = { checkedAt: new Date().toISOString(), model, sourceCount: sources.length, inputChars: input.length, attempts: [] };
for (let attempt = 1; attempt <= calls; attempt++) {
  const started = Date.now();
  const result = { attempt };
  try {
    const response = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...deepinfraGenerationOptions(model), model, temperature: 0, max_tokens: 2000,
        messages: [{ role: 'system', content: memory.FACT_EXTRACTION_RULES }, { role: 'user', content: input }],
        response_format: memory.factExtractionFormat(sources.map(s => s.id)),
      }), signal: AbortSignal.timeout(40000), redirect: 'error',
    });
    result.httpStatus = response.status;
    if (response.ok) {
      const data = await response.json();
      result.finishReason = ['stop', 'length', 'content_filter'].includes(data.choices?.[0]?.finish_reason) ? data.choices[0].finish_reason : 'unknown';
      result.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].map(k => [k, data.usage?.[k]]).filter(([,v]) => typeof v === 'number'));
      try {
        const parsed = memory.parseFactExtraction(data.choices?.[0]?.message?.content ?? '', sources);
        Object.assign(result, { valid: true, facts: parsed.facts.length, events: parsed.events.length, rejectedRetractions: parsed.rejectedRetractions });
      } catch (error) {
        if (!(error instanceof memory.MemoryExtractionError)) throw error;
        Object.assign(result, { valid: false, code: error.code, ...error.diagnostic });
      }
    }
  } catch (error) { result.requestFailure = error?.name === 'TimeoutError' ? 'timeout' : 'request_failed'; }
  result.durationMs = Date.now() - started;
  report.attempts.push(result);
  console.log(JSON.stringify(result));
}
writeFileSync(arg('--out'), JSON.stringify(report, null, 2) + '\n');
