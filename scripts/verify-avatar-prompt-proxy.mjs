// Actual writer -> service client -> telemetry -> CONNECT agent. No .env, DB or paid calls.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createChatDiagnosticRuntime, diagnosticRoot } from './lib/chat-diagnostic-runtime.mjs';

for (const key of Object.keys(process.env)) {
  if (/^(LOGTAIL_|AI_COST_|DEEPINFRA_|CHAT_AI_PROVIDER|MEMORY_AI_PROVIDER|KODIKROUTER_API_KEY|AVATAR_PROMPT_LLM_ENABLED)/.test(key)) delete process.env[key];
}
Object.assign(process.env, { MEMORY_AI_PROVIDER: 'deepinfra', DEEPINFRA_API_KEY: 'synthetic_deepinfra_key',
  KODIKROUTER_API_KEY: 'synthetic_legacy_key', AVATAR_PROMPT_LLM_ENABLED: 'true', DEEPINFRA_PROXY_URL: 'http://proxy.example:3128' });
const scene = 'A weathered innkeeper in a linen apron stands by a stone hearth, warm firelight on her face, dried herbs hanging from dark wooden beams, a calm and welcoming expression.';
const calls = [], logs = [];
let mode = 'ok';
const fakeAxios = {
  isAxiosError: value => value?.isAxiosError === true,
  post: async (url, body, config) => {
    calls.push({ url, body, config });
    if (mode === 'timeout' || mode === 'network') throw Object.assign(new Error('synthetic_private_provider_error'),
      { isAxiosError: true, code: mode === 'timeout' ? 'ECONNABORTED' : 'ECONNRESET', config: { secret: 'synthetic_private_key' } });
    return { status: 200, headers: {}, data: { choices: [{ message: { content: mode === 'invalid' ? 'not JSON' : JSON.stringify({ description: scene }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 60 } } };
  },
};
const runtime = createChatDiagnosticRuntime({ axios: fakeAxios });
runtime.logger.setDiagnosticSink({ error: line => logs.push(line), info: line => logs.push(line), debug: line => logs.push(line) });
const writer = runtime.load(join(diagnosticRoot, 'src/lib/avatarPromptWriter.ts'));
const body = { name: 'Synthetic', description: 'synthetic_private_card', referenceImage: 'data:image/png;base64,synthetic_private_reference' };
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; console.log(`PASS ${label}`); }
const result = await writer.writeAvatarPrompt(body, 'synthetic_template');
check(result.source === 'llm' && result.prompt.includes(scene), 'actual writer returns the model scene with code-owned composition');
const wire = calls.at(-1);
check(wire.url === 'https://api.deepinfra.com/v1/openai/chat/completions'
  && wire.body.model === 'mistralai/Mistral-Small-3.2-24B-Instruct-2506', 'avatar prompt targets the configured DeepInfra model');
check(wire.config.proxy === false && wire.config.httpsAgent instanceof HttpsProxyAgent,
  'actual writer request receives the shared HTTPS CONNECT agent');
check(wire.config.httpsAgent.keepAlive === true && wire.config.httpsAgent.options.rejectUnauthorized !== false,
  'shared proxy keeps connections alive without disabling TLS checks');
check(wire.config.headers.Authorization === 'Bearer synthetic_deepinfra_key' && wire.config.timeout === 10000
  && wire.config.maxRedirects === 0 && wire.body.max_tokens === 450 && wire.body.temperature === 0.5,
  'DeepInfra key, writer deadline, redirect refusal and generation limits survive the proxy route');
check(!JSON.stringify(wire.body).includes('synthetic_private_reference'), 'reference image never reaches the text provider');
check(logs.some(line => line.includes('AvatarPrompt') && line.includes('"networkRoute":"proxy"')),
  'successful avatar prompt logs the applied proxy route without logging its address');
check([...runtime.rows.values()].some(row => row.purpose === 'avatar_prompt' && row.provider === 'deepinfra' && row.outcome === 'completed'),
  'prompt request keeps separate avatar_prompt cost accounting');
const firstAgent = wire.config.httpsAgent;
await writer.writeAvatarPrompt(body, 'synthetic_template');
check(calls.at(-1).config.httpsAgent === firstAgent, 'writer reuses the existing service proxy agent');
for (const failure of ['timeout', 'network', 'invalid']) {
  mode = failure;
  const fallback = await writer.writeAvatarPrompt(body, 'synthetic_template');
  check(fallback.source === 'template' && fallback.prompt === 'synthetic_template'
    && fallback.reason === (failure === 'timeout' ? 'timeout' : failure === 'invalid' ? 'invalid' : 'error'),
    `${failure}: proxy/writer failure preserves the deterministic avatar fallback`);
}
check(logs.some(line => line.includes('service attempt failed') && line.includes('"networkRoute":"proxy"') && line.includes('"purpose":"avatar_prompt"')),
  'failed prompt request retains purpose and proxy route in technical diagnostics');
mode = 'ok';
process.env.DEEPINFRA_PROXY_URL = 'http://proxy.example/path?token=synthetic_private_proxy_secret';
let before = calls.length;
const malformed = await writer.writeAvatarPrompt(body, 'synthetic_template');
check(calls.length === before && malformed.source === 'template', 'invalid proxy fails closed before any direct request');
delete process.env.DEEPINFRA_PROXY_URL;
await writer.writeAvatarPrompt(body, 'synthetic_template');
check(!calls.at(-1).config.httpsAgent && logs.some(line => line.includes('AvatarPrompt') && line.includes('"networkRoute":"direct"')),
  'explicitly unconfigured proxy retains the documented direct route');
process.env.DEEPINFRA_PROXY_URL = 'http://proxy.example:3128';
process.env.MEMORY_AI_PROVIDER = 'kodikrouter';
await writer.writeAvatarPrompt(body, 'synthetic_template');
check(calls.at(-1).url === 'https://api.kodikrouter.ru/v1/chat/completions' && !calls.at(-1).config.httpsAgent
  && calls.at(-1).config.headers.Authorization === 'Bearer synthetic_legacy_key', 'legacy provider is not accidentally sent through the DeepInfra proxy');
process.env.AVATAR_PROMPT_LLM_ENABLED = 'false'; before = calls.length;
check((await writer.writeAvatarPrompt(body, 'synthetic_template')).reason === 'disabled' && calls.length === before,
  'disabled writer makes no text request');
check(!logs.join('\n').match(/synthetic_private_|synthetic_deepinfra_key|synthetic_legacy_key|proxy\.example|weathered innkeeper/),
  'diagnostics omit cards, scene text, reference data, keys, provider errors and proxy URL');
console.log(`${checks} avatar prompt proxy checks passed; no external network or production database.`);
