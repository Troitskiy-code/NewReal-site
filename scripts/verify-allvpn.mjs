import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseAllvpnSubscription, allvpnConfig } from './lib/allvpn-runtime.mjs';
import { createChatDiagnosticRuntime, diagnosticRoot } from './lib/chat-diagnostic-runtime.mjs';
import { probePipelineStream } from './lib/chat-stream-probe.mjs';

for (const key of Object.keys(process.env)) if (/^(ALLVPN_|DEEPINFRA_|LOGTAIL_|CHAT_AI_PROVIDER|MEMORY_AI_PROVIDER)/.test(key)) delete process.env[key];
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log(`PASS ${label}`); };
const link = 'vless://11111111-1111-4111-8111-111111111111@vpn.example:443?security=reality&type=tcp&encryption=none&flow=xtls-rprx-vision&pbk=' + 'a'.repeat(43) + '&sni=example.com&sid=abcd&fp=chrome#synthetic';
const nodes = parseAllvpnSubscription(Buffer.from(link).toString('base64'));
check(nodes.length === 1 && nodes[0].outbound.streamSettings.security === 'reality', 'standard base64 VLESS Reality subscription converted');
const config = allvpnConfig(nodes[0], 18080);
check(config.inbounds[0].listen === '127.0.0.1' && config.outbounds.length === 1 && config.outbounds[0].protocol === 'vless', 'VPN listener is loopback only, with no direct outbound');
check(config.log.loglevel === 'none' && config.log.access === 'none', 'Xray payload and credential logs disabled');
for (const bad of [link.replace('security=reality', 'security=none'), link.replace('type=tcp', 'type=ws'), link.replace('sid=abcd', 'sid=abc'), 'happ://crypt5/example']) {
  check(parseAllvpnSubscription(bad).every(node => node === null), 'unsupported or malformed link cannot become a direct route');
}
const grpc = parseAllvpnSubscription(link.replace('type=tcp', 'type=grpc').replace('flow=xtls-rprx-vision', 'flow='))[0];
check(grpc.outbound.streamSettings.grpcSettings && !grpc.outbound.settings.vnext[0].users[0].flow, 'gRPC uses its transport settings without incompatible Vision flow');

const calls = [];
class FetchAgent { constructor(url) { this.url = url.replace(/\/$/, ''); } async close() {} }
class HttpAgent { constructor(url) { this.url = url.replace(/\/$/, ''); } }
let failPrimary = false, status = 200, partial = false;
const frame = data => `data: ${JSON.stringify(data)}\n\n`;
const runtime = createChatDiagnosticRuntime({
  undici: { ProxyAgent: FetchAgent, fetch: async (url, init) => {
    calls.push({ url, proxy: init.dispatcher?.url, body: init.body });
    if (failPrimary && init.dispatcher?.url === 'http://primary.example:3128') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (status !== 200) return new Response('', { status });
    const text = frame({ choices: [{ delta: { content: 'Synthetic test reply' } }] });
    const terminal = frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + 'data: [DONE]\n\n';
    let sent = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(text)); return; }
      if (partial) controller.error(Object.assign(new Error('network'), { code: 'ECONNRESET' }));
      else { controller.enqueue(new TextEncoder().encode(terminal)); controller.close(); }
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } }, 'https-proxy-agent': { HttpsProxyAgent: HttpAgent },
});
runtime.logger.setDiagnosticSink({ info() {}, debug() {}, error() {} });
const network = runtime.load(join(diagnosticRoot, 'src/lib/deepinfraNetwork.ts'));
const url = 'https://api.deepinfra.com/v1/openai/chat/completions';
process.env.DEEPINFRA_PROXY_URL = 'http://primary.example:3128';
process.env.ALLVPN_PROXY_URL = 'http://127.0.0.1:18080';
process.env.CHAT_AI_PROVIDER = 'deepinfra';
process.env.DEEPINFRA_API_KEY = 'synthetic_key';
const oldNow = Date.now;
try {
  let now = oldNow(); Date.now = () => now;
  check(network.deepinfraRequestPlan(url).route === 'proxy', 'automatic mode starts on original proxy');
  const primary = network.deepinfraRequestPlan(url);
  network.markDeepinfraNetworkFailure(primary, { code: 'ECONNRESET' });
  check(network.deepinfraRequestPlan(url).route === 'allvpn', 'network failure opens 60-second reserve window');
  network.markDeepinfraNetworkSuccess(network.deepinfraRequestPlan(url));
  check(network.deepinfraRequestPlan(url).route === 'allvpn', 'reserve success does not prematurely restore failed primary');
  now += 60001;
  check(network.deepinfraRequestPlan(url).route === 'proxy', 'primary is tried again after cooldown');
  for (const error of [{ response: { status: 401 }, code: 'ECONNRESET' }, { name: 'AbortError' }, { code: 'CERT_HAS_EXPIRED' }, { response: { status: 429 } }]) {
    network.markDeepinfraNetworkFailure(network.deepinfraRequestPlan(url), error);
    check(network.deepinfraRequestPlan(url).route === 'proxy', 'HTTP/auth/rate-limit/certificate/cancellation errors do not switch routes');
  }
  process.env.DEEPINFRA_NETWORK_MODE = 'allvpn';
  check(network.deepinfraRequestPlan(url).route === 'allvpn' && network.deepinfraAxiosOptions(url).httpsAgent.url === process.env.ALLVPN_PROXY_URL, 'forced mode selects AllVPN for streams and services');
  check(network.deepinfraRequestPlan('https://api.kie.ai/example').route === 'direct', 'unrelated endpoints and providers are isolated');
  delete process.env.ALLVPN_PROXY_URL;
  assert.throws(() => network.deepinfraRequestPlan(url), /configuration is invalid/);
  check(true, 'forced mode without reserve fails closed');
  process.env.ALLVPN_PROXY_URL = 'http://127.0.0.1:18080';
  process.env.DEEPINFRA_NETWORK_MODE = 'primary';
  network.markDeepinfraNetworkFailure(network.deepinfraRequestPlan(url), { code: 'ECONNRESET' });
  check(network.deepinfraRequestPlan(url).route === 'proxy', 'primary-only mode disables failover');
} finally { Date.now = oldNow; }

process.env.DEEPINFRA_NETWORK_MODE = 'auto';
failPrimary = true;
const input = { modelName: 'deepinfra:google/gemma-4-31B-it-turbo', key: 'synthetic_key', runtime,
  messages: [{ role: 'user', content: 'Synthetic test' }] };
const result = await probePipelineStream(input);
check(result.outcome === 'completed' && result.attempts.length === 2 && result.attempts[0].outcome === 'failed' && result.attempts[1].outcome === 'completed', 'real chat retry uses reserve with separate per-attempt accounting');
check(calls.at(-2).proxy === 'http://primary.example:3128' && calls.at(-1).proxy === 'http://127.0.0.1:18080'
  && calls.at(-2).body === calls.at(-1).body, 'retry preserves model, serialized payload and key route');
process.env.DEEPINFRA_NETWORK_MODE = 'allvpn'; partial = true;
const before = calls.length;
const incomplete = await probePipelineStream(input);
check(incomplete.outcome === 'failed' && calls.length === before + 1, 'partially delivered stream is never regenerated or replayed');
check(network.deepinfraRequestPlan(url).route === 'allvpn', 'forced failures never escape to original proxy or direct connection');
console.log(`${checks} AllVPN checks passed, no external network or database.`);
