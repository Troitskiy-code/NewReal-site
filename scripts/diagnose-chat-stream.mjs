// No API requests by default. --live explicitly enables billed calls. Never connects to the app DB.
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createChatDiagnosticRuntime } from './lib/chat-diagnostic-runtime.mjs';
import { probeDirectStream, probePipelineStream } from './lib/chat-stream-probe.mjs';

const help = `Chat transport diagnostic
  node scripts/diagnose-chat-stream.mjs [options]
  --model <API or deepinfra:catalog name>    Default: the catalog base model
  --mode direct|pipeline|both               Default: both; sequential independent requests
  --runs 1..3                              Default: 1
  --context-repeats 0..1000                 Synthetic context size; default: 80
  --messages-file <JSON path>              Optional array of role/content messages; never printed
  --env-file <path>                        Explicitly load key from this file only for --live
  --live                                   Enable real DeepInfra calls (may be billed)
  --help                                   Show this help
Direct uses a 120s total limit and no idle limit. Pipeline uses real app timeouts/retries,
in-memory accounting and the real reply consumer, without Next HTTP routing, DB or wallet writes.
Reports contain timings/counters/IDs only. Save output to the ignored logs/ directory.`;

async function main() {
  const args = process.argv.slice(2), opts = {};
  const valued = new Set(['model', 'mode', 'runs', 'context-repeats', 'messages-file', 'env-file']);
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    if (args[i] === '--help') { console.log(help); return; }
    if (args[i] === '--live') { opts.live = true; continue; }
    if (!args[i].startsWith('--') || !valued.has(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid arguments. Use --help.');
    opts[name] = args[++i];
  }
  if (opts.live && opts['env-file']) {
    const { config } = await import('dotenv');
    const loaded = config({ path: opts['env-file'], quiet: true });
    if (loaded.error) throw new Error('Cannot read the selected env file.');
  }
  // Never send probe diagnostics to a configured external sink or use any app database.
  delete process.env.LOGTAIL_SOURCE_TOKEN; delete process.env.LOGTAIL_INGESTING_HOST;
  process.env.CHAT_AI_PROVIDER = 'deepinfra'; process.env.CHAT_TRANSPORT_TRACE = '1';
  const runtime = createChatDiagnosticRuntime();
  const catalog = runtime.load(fileURLToPath(new URL('../src/lib/deepinfraModels.ts', import.meta.url)));
  const model = catalog.deepinfraModel(opts.model ?? catalog.DEEPINFRA_BASE_MODEL);
  if (!model || !catalog.DEEPINFRA_AVAILABLE_MODEL_NAMES.includes(model.name)) throw new Error('Choose an available DeepInfra model from the application catalog.');
  const mode = opts.mode ?? 'both', runs = Number(opts.runs ?? 1), repeats = Number(opts['context-repeats'] ?? 80);
  if (!['direct', 'pipeline', 'both'].includes(mode) || !Number.isInteger(runs) || runs < 1 || runs > 3
    || !Number.isInteger(repeats) || repeats < 0 || repeats > 1000) throw new Error('Invalid mode, runs or context size. Use --help.');
  let messages = [
    { role: 'system', content: 'Ты — хранитель лесного приюта. Отвечай по-русски. ' + 'Приют стоит в лесу; сюда приходят странники. '.repeat(repeats) },
    { role: 'user', content: 'Можно переночевать в приюте? Расскажи о нём и предложи, что делать дальше.' },
  ];
  if (opts['messages-file']) {
    if (statSync(opts['messages-file']).size > 256_000) throw new Error('Messages file exceeds 256 KB.');
    messages = JSON.parse(readFileSync(opts['messages-file'], 'utf8'));
    if (!Array.isArray(messages) || !messages.length || messages.length > 200 || messages.some(m => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) throw new Error('Expected an array of role/content messages.');
    messages = messages.map(({ role, content }) => ({ role, content }));
  }
  const body = { model: model.apiModel, messages, ...runtime.policy.chatModelGenerationOptions(model.name), stream: true, stream_options: { include_usage: true } };
  console.log(JSON.stringify({ event: 'plan', live: !!opts.live, model: model.apiModel, mode, runs,
    messageCount: messages.length, inputChars: messages.reduce((n, m) => n + m.content.length, 0),
    pipelineLimits: runtime.policy.chatModelStreamTimeouts(model.name), directTotalMs: 120_000,
    maxProviderCalls: runs * (mode === 'both' ? 3 : mode === 'pipeline' ? 2 : 1),
    nodeVersion: process.version, database: 'in_memory', httpRouteTested: false }));
  if (!opts.live) { console.log('Dry run only. Add --live to send billed requests.'); return; }
  const key = process.env.DEEPINFRA_API_KEY?.trim();
  if (!key) throw new Error('DEEPINFRA_API_KEY is required for --live.');
  for (let run = 1; run <= runs; run++) {
    let direct, pipeline;
    if (mode !== 'pipeline') {
      direct = await probeDirectStream({ body, key, runtime, emit: fields => console.log(JSON.stringify({ run, mode: 'direct', ...fields })) });
      console.log(JSON.stringify({ event: 'result', run, ...direct }));
    }
    if (mode !== 'direct') {
      pipeline = await probePipelineStream({ messages, modelName: model.name, key, runtime });
      console.log(JSON.stringify({ event: 'result', run, ...pipeline }));
    }
    if (direct && pipeline) {
      console.log(JSON.stringify({ event: 'comparison', run, direct: direct.outcome, pipeline: pipeline.outcome,
        observation: direct.outcome === 'completed' && pipeline.outcome === 'failed' ? 'investigate_app_limits_and_processing'
          : direct.outcome === 'failed' && pipeline.outcome === 'failed' ? 'investigate_provider_and_server_connection'
          : direct.outcome === 'completed' && pipeline.outcome === 'completed' ? 'failure_not_reproduced' : 'variable_provider_or_connection',
        independentRequests: true, causalProof: false }));
    }
  }
}
main().catch(() => { console.error('Diagnostic could not start or finish. Check arguments, selected file and key; private error details are suppressed.'); process.exitCode = 1; });
