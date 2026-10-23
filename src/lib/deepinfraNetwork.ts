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
  "https://api.deepinfra.com/v1/openai/audio/speech",
]);
function proxyUrl(name: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.href;
  } catch { throw new DeepinfraNetworkConfigurationError(); }
}
type NetworkPlan = { route: "direct" | "proxy" | "allvpn"; proxy: string | null; key: string; primary: boolean };
let circuit = { key: "", until: 0 };
const cached = new Map<string, { fetchAgent: ProxyAgent; httpsAgent: HttpsProxyAgent<string> }>();
function agents(url: string) {
  if (!cached.has(url)) cached.set(url, { fetchAgent: new ProxyAgent(url), httpsAgent: new HttpsProxyAgent(url, { keepAlive: true }) });
  return cached.get(url)!;
}
export function deepinfraRequestPlan(url: string): NetworkPlan {
  if (!endpoints.has(url)) return { route: "direct", proxy: null, key: "", primary: false };
  const mode = process.env['DEEPINFRA_NETWORK_MODE']?.trim() || "auto";
  if (!["auto", "primary", "allvpn"].includes(mode)) throw new DeepinfraNetworkConfigurationError();
  // Forced tests do not require the original proxy, and never bypass AllVPN on failure.
  const primary = mode === "allvpn" ? null : proxyUrl("DEEPINFRA_PROXY_URL");
  const fallback = mode === "primary" ? null : proxyUrl("ALLVPN_PROXY_URL");
  if (mode === "allvpn" && !fallback) throw new DeepinfraNetworkConfigurationError();
  const key = JSON.stringify([mode, primary, fallback]);
  if (circuit.key !== key) circuit = { key, until: 0 };
  if (mode === "allvpn" || (fallback && Date.now() < circuit.until)) {
    return { route: "allvpn", proxy: fallback, key, primary: false };
  }
  return { route: primary ? "proxy" : "direct", proxy: primary, key, primary: true };
}
export function deepinfraNetworkRoute(): "direct" | "proxy" {
  return deepinfraRequestPlan([...endpoints][0]).route === "direct" ? "direct" : "proxy";
}
export function markDeepinfraNetworkFailure(plan: NetworkPlan, error: unknown, signal?: AbortSignal | null) {
  if (!plan.primary || !plan.key || plan.key !== circuit.key || process.env['DEEPINFRA_NETWORK_MODE'] === "primary"
    || !process.env['ALLVPN_PROXY_URL']?.trim()) return;
  const failure = (signal?.aborted ? signal.reason : error) as { name?: string; stage?: string; code?: string; cause?: { code?: string }; response?: unknown };
  if (!failure || failure.response) return;
  // User cancellations, authentication/HTTP errors and certificate errors never trigger a route change.
  const timeout = failure.name === "TimeoutError" && (!failure.stage || failure.stage === "first_byte" || failure.stage === "idle");
  if (signal?.aborted && !timeout) return;
  const code = failure.code ?? failure.cause?.code;
  const network = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNABORTED",
    "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code ?? "");
  if (timeout || network) circuit.until = Date.now() + 60_000;
}
export function markDeepinfraNetworkSuccess(plan: NetworkPlan) {
  if (plan.primary && plan.key === circuit.key) circuit.until = 0;
}
// A control request with the same Undici version as the proxy path, but no proxy dispatcher.
export async function directDeepinfraFetch(url: string, init: RequestInit): Promise<Response> {
  if (!endpoints.has(url)) throw new DeepinfraNetworkConfigurationError();
  return await proxyFetch(url, init as UndiciRequestInit) as unknown as Response;
}
export async function deepinfraFetch(url: string, init: RequestInit, plan = deepinfraRequestPlan(url)): Promise<Response> {
  try {
    const response = plan.proxy
      ? await proxyFetch(url, { ...init, dispatcher: agents(plan.proxy).fetchAgent } as UndiciRequestInit) as unknown as Response
      : await fetch(url, init);
    if (response.ok) markDeepinfraNetworkSuccess(plan);
    return response;
  } catch (error) {
    markDeepinfraNetworkFailure(plan, error, init.signal);
    throw error;
  }
}
export function deepinfraAxiosOptions(url: string, plan = deepinfraRequestPlan(url)) {
  return plan.proxy ? { proxy: false as const, httpsAgent: agents(plan.proxy).httpsAgent } : {};
}
