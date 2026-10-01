const RAG_SUBSCRIPTION_TYPES = new Set(["dialog", "history", "story", "universe"]);

export function isMessageEmbeddingsFlagEnabled(): boolean {
  return process.env.ENABLE_RAG_EMBEDDINGS === "true";
}

export function isRagEligible(
  subscriptionType: string | null | undefined,
  subscriptionActive: boolean
): boolean {
  if (!subscriptionActive) return false;
  const normalized = (subscriptionType ?? "").trim().toLowerCase();
  return RAG_SUBSCRIPTION_TYPES.has(normalized);
}

export function shouldPersistEmbeddings(
  subscriptionType: string | null | undefined,
  subscriptionActive: boolean
): boolean {
  return isRagEligible(subscriptionType, subscriptionActive) || isMessageEmbeddingsFlagEnabled();
}
