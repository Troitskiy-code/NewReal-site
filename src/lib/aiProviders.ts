import { DEEPINFRA_AVAILABLE_MODEL_NAMES, DEEPINFRA_BASE_MODEL, DEEPINFRA_MODEL_NAMES, deepinfraModel } from "./deepinfraModels";
import { NON_DEFAULT_CHAT_MODEL_NAMES, RETIRED_TESTING_CHAT_MODEL_NAMES } from "./testingChatModels";

export type TextProvider = "kodikrouter" | "deepinfra";
export const KODIK_CHAT_URL = "https://api.kodikrouter.ru/v1/chat/completions";
export const DEEPINFRA_CHAT_URL = "https://api.deepinfra.com/v1/openai/chat/completions";
export class AiProviderConfigurationError extends Error {
  readonly __noRetry = true;
  constructor() { super("AI provider is not configured"); this.name = "AiProviderConfigurationError"; }
}
function configuredProvider(value: string | undefined): TextProvider {
  if (!value?.trim()) return "kodikrouter";
  if (value === "kodikrouter" || value === "deepinfra") return value;
  throw new AiProviderConfigurationError();
}
export function getChatProvider(): TextProvider { return configuredProvider(process.env['CHAT_AI_PROVIDER']); }
export function getMemoryProvider(): TextProvider { return configuredProvider(process.env['MEMORY_AI_PROVIDER']); }
export function providerApiKey(provider: TextProvider, legacyKey?: string): string {
  const key = provider === "deepinfra" ? process.env['DEEPINFRA_API_KEY'] : legacyKey ?? process.env.KODIKROUTER_API_KEY;
  if (!key?.trim()) throw new AiProviderConfigurationError();
  return key.trim();
}
export function chatProviderConfigured(): boolean {
  try { providerApiKey(getChatProvider()); return true; } catch { return false; }
}
export function memoryProviderConfigured(legacyKey?: string): boolean {
  try { providerApiKey(getMemoryProvider(), legacyKey); return true; } catch { return false; }
}
export function deepinfraUsdRub(): number | null {
  const value = Number(process.env['DEEPINFRA_USD_RUB']);
  return Number.isFinite(value) && value > 0 ? value : null;
}
export function chatModelNameFilter(baseOnly = false) {
  return getChatProvider() === "deepinfra"
    ? { in: baseOnly ? [DEEPINFRA_BASE_MODEL] : DEEPINFRA_AVAILABLE_MODEL_NAMES }
    : { notIn: baseOnly ? NON_DEFAULT_CHAT_MODEL_NAMES : [...RETIRED_TESTING_CHAT_MODEL_NAMES, ...DEEPINFRA_MODEL_NAMES] };
}
export function availableChatModel(name: string): boolean {
  if (getChatProvider() === "deepinfra") return DEEPINFRA_AVAILABLE_MODEL_NAMES.includes(name);
  return !name.startsWith("deepinfra:") && !RETIRED_TESTING_CHAT_MODEL_NAMES.includes(name);
}
export function chatTransport(name: string, legacyKey?: string) {
  const provider = getChatProvider();
  if (!availableChatModel(name)) throw new AiProviderConfigurationError();
  const model = provider === "deepinfra" ? deepinfraModel(name)?.apiModel : name;
  if (!model) throw new AiProviderConfigurationError();
  return { provider, model, url: provider === "deepinfra" ? DEEPINFRA_CHAT_URL : KODIK_CHAT_URL,
    apiKey: providerApiKey(provider, legacyKey) };
}
// Embedding storage is isolated per provider; only allow the exact fixed API URLs.
export function textProviderForUrl(url: string): TextProvider {
  if (url === DEEPINFRA_CHAT_URL || url === "https://api.deepinfra.com/v1/openai/embeddings") return "deepinfra";
  if (url === KODIK_CHAT_URL || url === "https://api.kodikrouter.ru/v1/embeddings") return "kodikrouter";
  throw new AiProviderConfigurationError();
}
export function serviceTransport(purpose: string, requestedModel: string, legacyKey?: string) {
  const provider = purpose === "character_generation" ? "deepinfra" : getMemoryProvider();
  const choices: Record<string, string> = {
    // 2026-10-24 chapter summaries on a 171-message story, manual beat scoring: Gemma 4 Turbo 69–82%
    // (three runs, 1–2 compressions), GPT-6 Luna 42–49%, Mistral Small 3.2 22–28% (it wrote three full
    // items per chapter, so the oldest chapters were re-compressed every step). Also the Kie reserve.
    summary: "google/gemma-4-31B-it-turbo",
    // 2026-10-20 eval (scripts/eval-memory-extraction-models.mjs, production-sized turns): Gemma 4 Turbo recall
    // 68% vs 53% for Mistral Small 3.2, 2 vs 16 false facts, p90 4.2 s vs 15.5 s. Qwen3-Next scored the same
    // offline but failed 17% of daytime production calls (75 s timeouts, HTTP 500) on 2026-10-21; Gemma is
    // the chat base model with ample DeepInfra capacity (~0.1% failures on the memory purpose).
    memory_extract: "google/gemma-4-31B-it-turbo",
    intent: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
    memory: requestedModel === "google/gemma-4-31b-it" ? "google/gemma-4-31B-it-turbo" : "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
    character_event: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
    character_prompt: "Qwen/Qwen3-235B-A22B-Instruct-2507",
    character_generation: "Qwen/Qwen3-235B-A22B-Instruct-2507",
    // Fast and multilingual: reads Russian cards, writes the English image description.
    avatar_prompt: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
  };
  if (!Object.hasOwn(choices, purpose)) throw new AiProviderConfigurationError();
  const serviceModel = purpose === "character_generation" && requestedModel === "mistralai/Mistral-Small-3.2-24B-Instruct-2506"
    ? requestedModel : choices[purpose];
  return { provider, model: provider === "deepinfra" ? serviceModel : requestedModel,
    url: provider === "deepinfra" ? DEEPINFRA_CHAT_URL : KODIK_CHAT_URL,
    apiKey: providerApiKey(provider, legacyKey) };
}
