import catalog from "./data/testing-chat-models-2026-10-10.json";

export const TESTING_CHAT_MODELS = catalog;
export const TESTING_CHAT_MODEL_NAMES = catalog.map((model) => model.name);

export function isTestingChatModel(name: string): boolean {
  return TESTING_CHAT_MODEL_NAMES.includes(name);
}

/** These are request settings, not proof that a gateway obeys a reasoning mode. */
export function chatModelGenerationOptions(modelName: string) {
  const base = { max_tokens: 1000, temperature: 0.7 };
  if (modelName === "xiaomi/mimo-v2.6-flash") {
    return { ...base, reasoning: { enabled: false, exclude: true } };
  }
  if (modelName === "aion-labs/aion-3.0-mini") {
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
  return isTestingChatModel(modelName) ? 60_000 : 30_000;
}
