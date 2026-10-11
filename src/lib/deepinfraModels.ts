import catalog from "./data/deepinfra-chat-models-2026-10-11.json";

// Distinct DB names preserve the Kodik catalogue and existing user selections.
export const DEEPINFRA_CHAT_MODELS = catalog;
export const DEEPINFRA_MODEL_NAMES = catalog.map((model) => model.name);
export const DEEPINFRA_BASE_MODEL = catalog[0].name;
// Hidden from users but kept in the catalog for cost quotes of past requests. Measured on 2026-10-11:
// DeepSeek V3.2 ignores reasoning_effort "none" and produced no visible token in 60 s;
// Hermes 3 405B produced no token in 60 s on two runs.
export const DISABLED_DEEPINFRA_MODEL_NAMES = [
  "deepinfra:deepseek-ai/DeepSeek-V3.2",
  "deepinfra:NousResearch/Hermes-3-Llama-3.1-405B",
];
/** Models users may select and chat with when DeepInfra is the chat provider. */
export const DEEPINFRA_AVAILABLE_MODEL_NAMES = DEEPINFRA_MODEL_NAMES.filter((name) => !DISABLED_DEEPINFRA_MODEL_NAMES.includes(name));
export function deepinfraModel(name: string) {
  return catalog.find((model) => model.name === name || model.apiModel === name);
}
export function deepinfraGenerationOptions(name: string) {
  const model = deepinfraModel(name);
  if (!model) throw new Error("Unknown DeepInfra model");
  return { max_tokens: 1000, temperature: 0.7, ...(model.reasoning ? { reasoning_effort: "none" } : {}) };
}
