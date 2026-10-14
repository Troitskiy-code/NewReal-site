import type { AxiosRequestConfig, AxiosResponse } from "axios";
import { meteredPost } from "./aiCostTelemetry";
import { KODIK_CHAT_URL, serviceTransport, AiProviderConfigurationError } from "./aiProviders";
import { deepinfraGenerationOptions } from "./deepinfraModels";
import { MAX_SUMMARY_GENERATION_TOKENS } from "./memorySummaryPolicy";

/** Service routing is explicit; it must never change an embedding's model/key. */
export async function serviceChatPost<T = AxiosResponse["data"]>(purpose: string, legacyUrl: string,
  body: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
  if (legacyUrl !== KODIK_CHAT_URL || !body || typeof body !== "object" || Array.isArray(body)) throw new AiProviderConfigurationError();
  const payload = body as Record<string, unknown>;
  const authorization = config?.headers?.Authorization;
  const legacyKey = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  const route = serviceTransport(purpose, String(payload.model ?? ""), legacyKey);
  if (route.provider === "kodikrouter") return meteredPost<T>(purpose, route.url, payload, { ...config, maxRedirects: 0 });
  // Preserve task-specific output caps and temperature, strip legacy-only settings.
  const { reasoning: _reasoning, reasoning_effort: _effort, service_tier: _tier, ...rest } = payload;
  void _reasoning; void _effort; void _tier;
  const requestedMax = Number(rest.max_tokens);
  // JSON generation is bounded independently of the persisted summary allowance.
  const outputLimit = purpose === "character_generation" ? 6000 : purpose === "summary" ? MAX_SUMMARY_GENERATION_TOKENS : 1000;
  const options = deepinfraGenerationOptions(route.model);
  return meteredPost<T>(purpose, route.url, { ...rest, ...options, model: route.model,
    max_tokens: Number.isSafeInteger(requestedMax) && requestedMax > 0 ? Math.min(requestedMax, outputLimit) : 1000,
    ...(typeof rest.temperature === "number" ? { temperature: rest.temperature } : {}) },
  { ...config, timeout: config?.timeout || 30_000, maxRedirects: 0,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${route.apiKey}` } });
}
