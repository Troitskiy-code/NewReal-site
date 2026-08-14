export const MESSAGE_EMBEDDINGS_ENABLED =
  process.env.ENABLE_RAG_EMBEDDINGS === "true";

export type RagMessage = {
  id: string;
  role: string;
  content: string;
  similarity?: number;
};

export type RagContext = {
  text: string;
  count: number;
};

export function isUniverseRagEligible(
  subscriptionType: string | null | undefined,
  subscriptionActive: boolean
): boolean {
  return subscriptionActive && subscriptionType === "universe";
}

export function shouldPersistEmbeddings(
  subscriptionType: string | null | undefined,
  subscriptionActive: boolean
): boolean {
  return MESSAGE_EMBEDDINGS_ENABLED || isUniverseRagEligible(subscriptionType, subscriptionActive);
}

export function formatRagContext(messages: RagMessage[]): RagContext | null {
  if (!messages || messages.length === 0) {
    return null;
  }

  const text = messages.map((message) => message.content).join("\n");
  return { text, count: messages.length };
}

export function appendRagToSystemPrompt(
  systemPrompt: string,
  ragContext: RagContext | null
): string {
  if (!ragContext?.text) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\nНа основе прошлых разговоров:\n${ragContext.text}`;
}

export async function searchRelevantMessages(
  _userId: string,
  _characterId: string,
  _queryText: string,
  _apiKey?: string,
  _excludeMessageId?: string
): Promise<RagMessage[]> {
  return [];
}

export function scheduleMessageEmbedding(
  _messageId: string,
  _content: string,
  _apiKey: string,
  persistEmbeddings: boolean
): void {
  if (!persistEmbeddings) {
    return;
  }

  console.log("🔍 RAG: сохранение эмбеддингов временно отключено (заглушка)");
}
