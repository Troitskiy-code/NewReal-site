import catalog from "./data/testing-roleplay-models-2026-10-10.json";
import previousCatalog from "./data/testing-chat-models-2026-10-10.json";
import { DEEPINFRA_CHAT_MODELS, DEEPINFRA_MODEL_NAMES, deepinfraGenerationOptions } from "./deepinfraModels";

export const TESTING_CHAT_MODELS = catalog;
export const TESTING_CHAT_MODEL_NAMES = catalog.map((model) => model.name);
export const RETIRED_TESTING_CHAT_MODEL_NAMES = previousCatalog
  .map((model) => model.name).filter((name) => !TESTING_CHAT_MODEL_NAMES.includes(name));
export const NON_DEFAULT_CHAT_MODEL_NAMES = [...TESTING_CHAT_MODEL_NAMES, ...RETIRED_TESTING_CHAT_MODEL_NAMES, ...DEEPINFRA_MODEL_NAMES];
// Retain old quotes for accounting of requests already in flight during a rollout.
export const CHAT_MODEL_CATALOG_QUOTES = [...catalog, ...previousCatalog];

export function isRetiredChatModel(name: string): boolean {
  return RETIRED_TESTING_CHAT_MODEL_NAMES.includes(name);
}

export function isTestingChatModel(name: string): boolean {
  return TESTING_CHAT_MODEL_NAMES.includes(name) || DEEPINFRA_CHAT_MODELS.some((model) => model.name === name && model.testing);
}

/** These are request settings, not proof that a gateway obeys a reasoning mode. */
export function chatModelGenerationOptions(modelName: string) {
  if (DEEPINFRA_MODEL_NAMES.includes(modelName)) return deepinfraGenerationOptions(modelName);
  const base = { max_tokens: 1000, temperature: 0.7 };
  if (modelName === "aion-labs/aion-2.0") {
    // Direct Aion accepts none. Routed support is unverified: retain a strict total cap.
    return { ...base, reasoning: { effort: "none", enabled: false, exclude: true } };
  }
  if (modelName === "aion-labs/aion-3.5-mini") {
    // Reasoning and visible output share this ceiling. Low is not a 3000-token hard cap.
    return { ...base, max_tokens: 4000, reasoning: { effort: "low", exclude: true } };
  }
  return base;
}

export function chatModelRequestTimeoutMs(modelName: string): number {
  if (DEEPINFRA_MODEL_NAMES.includes(modelName)) return 60_000;
  return isTestingChatModel(modelName) ? 60_000 : 30_000;
}

export type ChatStreamTimeouts = { firstByteMs: number; idleMs: number; totalMs: number };

/**
 * Streaming limits. A single 60 s timer for the whole stream, retried 3 times, let a stalled
 * provider hold a reply for up to 3 minutes and cut slow but working replies mid-sentence.
 * Reasoning models may stay silent while they think, so they get a longer gap between chunks.
 */
export function chatModelStreamTimeouts(modelName: string): ChatStreamTimeouts {
  const reasoning = DEEPINFRA_CHAT_MODELS.some((model) => model.name === modelName && model.reasoning)
    || modelName === "aion-labs/aion-3.5-mini";
  return { firstByteMs: 15_000, idleMs: reasoning ? 45_000 : 20_000, totalMs: 120_000 };
}
