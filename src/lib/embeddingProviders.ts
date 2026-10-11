import { AiProviderConfigurationError, getMemoryProvider, providerApiKey, type TextProvider } from "./aiProviders";

export const DEEPINFRA_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-0.6B";
export const DEEPINFRA_EMBEDDING_INPUT_USD_PER_MILLION = 0.01;
export const DEEPINFRA_EMBEDDING_URL = "https://api.deepinfra.com/v1/openai/embeddings";
export const EMBEDDING_BACKGROUND_TIMEOUT_MS = 8_000;
export type EmbeddingProvider = TextProvider | "disabled";

/** Separate override permits emergency disable; otherwise follow the memory provider. */
export function getEmbeddingProvider(): EmbeddingProvider {
  const value = process.env['EMBEDDING_AI_PROVIDER']?.trim();
  if (!value) return getMemoryProvider();
  if (value === "deepinfra" || value === "kodikrouter" || value === "disabled") return value;
  throw new AiProviderConfigurationError();
}

export function embeddingTransport(legacyKey?: string) {
  const provider = getEmbeddingProvider();
  if (provider === "disabled") throw new AiProviderConfigurationError();
  return {
    provider,
    model: provider === "deepinfra" ? DEEPINFRA_EMBEDDING_MODEL : "openai/text-embedding-3-small",
    dimensions: provider === "deepinfra" ? 1024 : 1536,
    url: provider === "deepinfra" ? DEEPINFRA_EMBEDDING_URL : "https://api.kodikrouter.ru/v1/embeddings",
    apiKey: providerApiKey(provider, legacyKey),
  };
}
