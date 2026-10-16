import catalog from "./data/deepinfra-chat-models-2026-10-11.json";

// Distinct DB names preserve the Kodik catalogue and existing user selections.
export const DEEPINFRA_CHAT_MODELS = catalog;
export const DEEPINFRA_MODEL_NAMES = catalog.map((model) => model.name);
// Default for guests and users without a usable selection; chosen by the 2026-10-16 RU/EN review.
export const DEEPINFRA_BASE_MODEL = "deepinfra:google/gemma-4-31B-it-turbo";
// Hidden from users but kept in the catalog for cost quotes of past requests. Measured on 2026-10-11:
// DeepSeek V3.2 ignores reasoning_effort "none" and produced no visible token in 60 s;
// Hermes 3 405B produced no token in 60 s on two runs.
// The rest failed the 2026-10-16 RU/EN review (docs/deepinfra-adult-roleplay-selection-2026-10-16.md):
// weak Russian, 26-49 s replies or provider content-policy risk.
export const DISABLED_DEEPINFRA_MODEL_NAMES = [
  "deepinfra:deepseek-ai/DeepSeek-V3.2",
  "deepinfra:NousResearch/Hermes-3-Llama-3.1-405B",
  "deepinfra:mistralai/Mistral-Small-3.2-24B-Instruct-2506",
  "deepinfra:meta-llama/Llama-3.3-70B-Instruct-Turbo",
  "deepinfra:Sao10K/L3.1-70B-Euryale-v2.2",
  "deepinfra:XiaomiMiMo/MiMo-V2.6-Flash",
  "deepinfra:google/gemini-2.5-flash",
  "deepinfra:NousResearch/Hermes-3-Llama-3.1-70B",
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
