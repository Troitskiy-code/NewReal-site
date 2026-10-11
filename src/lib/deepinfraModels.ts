import catalog from "./data/deepinfra-chat-models-2026-10-11.json";

// Distinct DB names preserve the Kodik catalogue and existing user selections.
export const DEEPINFRA_CHAT_MODELS = catalog;
export const DEEPINFRA_MODEL_NAMES = catalog.map((model) => model.name);
export const DEEPINFRA_BASE_MODEL = catalog[0].name;
export function deepinfraModel(name: string) {
  return catalog.find((model) => model.name === name || model.apiModel === name);
}
export function deepinfraGenerationOptions(name: string) {
  const model = deepinfraModel(name);
  if (!model) throw new Error("Unknown DeepInfra model");
  return { max_tokens: 1000, temperature: 0.7, ...(model.reasoning ? { reasoning_effort: "none" } : {}) };
}
