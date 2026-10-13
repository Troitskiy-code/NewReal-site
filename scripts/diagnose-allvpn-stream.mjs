import { writeFile, mkdir } from 'node:fs/promises';
import { loadAllvpnEnv, startAllvpnGateway } from './lib/allvpn-runtime.mjs';
import { createChatDiagnosticRuntime, diagnosticRoot } from './lib/chat-diagnostic-runtime.mjs';
import { probePipelineStream } from './lib/chat-stream-probe.mjs';
import { join } from 'node:path';

async function main() {
  loadAllvpnEnv();
  const live = process.argv.includes('--live');
  const networkOnly = process.argv.includes('--network-only');
  if (!live) { console.log('Dry run: add --live for one synthetic DeepInfra streaming test (up to 2 billed attempts, 128 output tokens each).'); return; }
  const key = process.env['DEEPINFRA_API_KEY']?.trim();
  if (!key && !networkOnly) { console.error('DEEPINFRA_API_KEY is not configured locally. Use --network-only for an unbilled connectivity check.'); process.exitCode = 1; return; }
  delete process.env.LOGTAIL_SOURCE_TOKEN; delete process.env.LOGTAIL_INGESTING_HOST;
  process.env.CHAT_AI_PROVIDER = 'deepinfra'; process.env.CHAT_TRANSPORT_TRACE = '1';
  process.env.DEEPINFRA_NETWORK_MODE = 'allvpn';
  const gateway = await startAllvpnGateway({ port: 0, onEvent: e => console.log(JSON.stringify(e)) });
  try {
    process.env.ALLVPN_PROXY_URL = gateway.proxyUrl;
    const runtime = createChatDiagnosticRuntime();
    const traces = [];
    runtime.logger.setDiagnosticSink({ info: line => traces.push(line), debug: line => traces.push(line), error: line => traces.push(line) });
    const generation = runtime.policy.chatModelGenerationOptions;
    runtime.policy.chatModelGenerationOptions = model => ({ ...generation(model), max_tokens: 128 });
    const plan = runtime.load(join(diagnosticRoot, 'src/lib/deepinfraNetwork.ts')).deepinfraRequestPlan('https://api.deepinfra.com/v1/openai/chat/completions');
    if (plan.route !== 'allvpn' || plan.proxy !== new URL(gateway.proxyUrl).href) throw new Error('route_not_forced');
    if (networkOnly) {
      console.log(JSON.stringify({ event: 'network_test_completed', route: plan.route, nodeIndex: gateway.nodeIndex,
        nodeCount: gateway.nodeCount, authenticatedStreamTested: false, billedRequests: 0 }));
      return;
    }
    const result = await probePipelineStream({ key, runtime,
      modelName: 'deepinfra:mistralai/Mistral-Small-3.2-24B-Instruct-2506',
      messages: [{ role: 'system', content: 'Это техническая проверка соединения. Ответь одной короткой фразой на русском языке.' },
        { role: 'user', content: 'Соединение работает?' }] });
    const report = { testedAt: new Date().toISOString(), route: plan.route, nodeIndex: gateway.nodeIndex, nodeCount: gateway.nodeCount,
      database: 'in_memory', productionHttpRouteTested: false, maxOutputTokens: 128, ...result,
      streamCompleted: traces.some(line => line.includes('attempt ended') && line.includes('"hasDone":true') && line.includes('"outcome":"completed"')) };
    await mkdir('logs', { recursive: true });
    await writeFile('logs/allvpn-live-report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (result.outcome !== 'completed' || !report.streamCompleted) process.exitCode = 1;
  } finally { await gateway.stop(); }
}
main().catch(() => { console.error('AllVPN streaming test could not complete; private details suppressed.'); process.exitCode = 1; });
