// Server-only, pointwise CONNECT tunnels. Never install a global dispatcher or relax TLS.
import { fetch as proxyFetch, ProxyAgent, type RequestInit as UndiciRequestInit } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";

export class DeepinfraNetworkConfigurationError extends Error {
  readonly __noRetry = true;
  constructor() { super("DeepInfra proxy configuration is invalid"); }
}
const endpoints = new Set([
  "https://api.deepinfra.com/v1/openai/chat/completions",
  "https://api.deepinfra.com/v1/openai/embeddings",
]);
function proxyUrl(): string | null {
  const raw = process.env['DEEPINFRA_PROXY_URL']?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.href;
  } catch { throw new DeepinfraNetworkConfigurationError(); }
}
let cached: { url: string; fetchAgent: ProxyAgent; httpsAgent: HttpsProxyAgent<string> } | null = null;
function agents(url: string) {
  if (cached?.url === url) return cached;
  const previous = cached;
  cached = { url, fetchAgent: new ProxyAgent(url), httpsAgent: new HttpsProxyAgent(url, { keepAlive: true }) };
  if (previous) { void previous.fetchAgent.close().catch(() => {}); previous.httpsAgent.destroy(); }
  return cached;
}
export function deepinfraNetworkRoute(): "direct" | "proxy" { return proxyUrl() ? "proxy" : "direct"; }
// A control request with the same Undici version as the proxy path, but no proxy dispatcher.
export async function directDeepinfraFetch(url: string, init: RequestInit): Promise<Response> {
  if (!endpoints.has(url)) throw new DeepinfraNetworkConfigurationError();
  return await proxyFetch(url, init as UndiciRequestInit) as unknown as Response;
}
export async function deepinfraFetch(url: string, init: RequestInit): Promise<Response> {
  const proxy = endpoints.has(url) ? proxyUrl() : null;
  if (!proxy) return fetch(url, init);
  const response = await proxyFetch(url, { ...init, dispatcher: agents(proxy).fetchAgent } as UndiciRequestInit);
  // Both implement the Web Response interface; the body stays streaming and cancellable.
  return response as unknown as Response;
}
export function deepinfraAxiosOptions(url: string) {
  const proxy = endpoints.has(url) ? proxyUrl() : null;
  return proxy ? { proxy: false as const, httpsAgent: agents(proxy).httpsAgent } : {};
}
