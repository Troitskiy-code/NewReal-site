import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createChatDiagnosticRuntime, diagnosticRoot } from './lib/chat-diagnostic-runtime.mjs';
const calls = [], instances = [];
class FetchAgent { constructor(url) { this.url = url; instances.push(this); } async close() {} }
class HttpAgent { constructor(url, options) { this.url = url; this.options = options; } destroy() {} }
const runtime = createChatDiagnosticRuntime({
  undici: { ProxyAgent: FetchAgent, fetch: async (url, init) => { calls.push({url,init}); return new Response('ok'); } },
  'https-proxy-agent': { HttpsProxyAgent: HttpAgent },
});
const network = runtime.load(join(diagnosticRoot,'src/lib/deepinfraNetwork.ts'));
const saved = process.env.DEEPINFRA_PROXY_URL, originalFetch = globalThis.fetch;
let checks = 0;
function check(value, name) { assert.ok(value,name); checks++; console.log(`PASS ${name}`); }
try {
  globalThis.fetch = async (url,init) => { calls.push({url,init,native:true}); return new Response('direct'); };
  delete process.env.DEEPINFRA_PROXY_URL;
  await network.deepinfraFetch('https://api.deepinfra.com/v1/openai/chat/completions',{});
  check(calls.at(-1).native && network.deepinfraNetworkRoute() === 'direct','empty proxy preserves native transport');
  process.env.DEEPINFRA_PROXY_URL = 'http://proxy.example:3128';
  const abort = new AbortController(), body = 'same serialized payload';
  await network.deepinfraFetch('https://api.deepinfra.com/v1/openai/chat/completions',{body,method:'POST',signal:abort.signal,redirect:'error'});
  check(!calls.at(-1).native && calls.at(-1).init.dispatcher instanceof FetchAgent,'DeepInfra stream uses explicit CONNECT dispatcher');
  check(calls.at(-1).init.signal === abort.signal && calls.at(-1).init.body === body && calls.at(-1).init.redirect === 'error','signal, payload and redirect policy preserved');
  await network.directDeepinfraFetch('https://api.deepinfra.com/v1/openai/chat/completions',{body,method:'POST',signal:abort.signal});
  check(!calls.at(-1).native && !calls.at(-1).init.dispatcher && calls.at(-1).init.body === body,'control uses same Undici client without a proxy dispatcher');
  const {Headers: UndiciHeaders} = await import('undici');
  const headers=runtime.diagnostics.safeTransportHeaders(new UndiciHeaders({'x-deepinfra-request-id':'proxy_request_123','retry-after':'2','content-type':'text/event-stream'}),'deepinfra');
  check(headers.providerRequestId === 'proxy_request_123' && headers.retryAfterMs === 2000 && headers.responseContentType === 'text/event-stream','Undici Headers retain safe request ID, content type and retry delay');
  const opts = network.deepinfraAxiosOptions('https://api.deepinfra.com/v1/openai/embeddings');
  check(opts.proxy === false && opts.httpsAgent instanceof HttpAgent && opts.httpsAgent.options.keepAlive,'embeddings and services use CONNECT rather than environment proxy');
  check(Object.keys(network.deepinfraAxiosOptions('https://api.kodikrouter.ru/v1/chat/completions')).length === 0,'other providers retain their route');
  await network.deepinfraFetch('https://other.example',{});
  check(calls.at(-1).native,'no global fetch replacement or unrelated proxy');
  network.deepinfraAxiosOptions('https://api.deepinfra.com/v1/openai/chat/completions');
  check(instances.length === 1 && !('requestTls' in instances[0]),'agents reused without TLS validation exceptions');
  for (const bad of ['file:///tmp/x','http://proxy.example/path','http://proxy.example?token=private','garbage']) {
    process.env.DEEPINFRA_PROXY_URL = bad;
    assert.throws(() => network.deepinfraNetworkRoute(), /configuration is invalid/);
  }
  check(true,'bad settings fail closed with no credential-bearing error text');
} finally { globalThis.fetch = originalFetch; if(saved === undefined) delete process.env.DEEPINFRA_PROXY_URL; else process.env.DEEPINFRA_PROXY_URL = saved; }
console.log(`${checks} network routing checks passed.`);
