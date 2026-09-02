import axios from "axios";
import { prisma } from "@/lib/prisma";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const RAG_TOP_K = 5;
const RAG_MIN_SIMILARITY = 0.25;
export const RAG_HISTORY_TOKEN_THRESHOLD = 3000;

const RAG_QUESTION_WORD_RE =
  /(?:^|[^\p{L}])(?:кто|что|где|когда|почему|как)(?=[^\p{L}]|$)/iu;

export type RagDecision = {
  use: boolean;
  reason: string;
};

export function shouldUseRag({
  ragEligible,
  userQuery,
  intent,
  historyTokens,
}: {
  ragEligible: boolean;
  userQuery?: string | null;
  intent: string;
  historyTokens: number;
}): RagDecision {
  if (!ragEligible) {
    return { use: false, reason: "not-eligible" };
  }

  const query = userQuery?.trim() ?? "";
  if (!query) {
    return { use: false, reason: "no-query" };
  }

  if (RAG_QUESTION_WORD_RE.test(query)) {
    return { use: true, reason: "question-words" };
  }

  if (intent === "fact" || intent === "question") {
    return { use: true, reason: `intent=${intent}` };
  }

  if (historyTokens > RAG_HISTORY_TOKEN_THRESHOLD) {
    return { use: true, reason: `history=${historyTokens}` };
  }

  return { use: false, reason: "not-needed" };
}

export const MESSAGE_EMBEDDINGS_ENABLED =
  process.env.ENABLE_RAG_EMBEDDINGS === "true";

export type RagMessage = {
  id: string;
  role: string;
  content: string;
  similarity: number;
};

export type RagContext = {
  text: string;
  count: number;
};

type RagSearchRow = {
  id: string;
  role: string;
  content: string;
  similarity: number;
};

async function fetchEmbedding(text: string, apiKey: string): Promise<Float32Array> {
  const response = await axios.post(
    `${KODIKROUTER_URL}/embeddings`,
    {
      model: EMBEDDING_MODEL,
      input: text,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const vector = response.data?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("Пустой эмбеддинг от API");
  }

  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Неожиданная размерность эмбеддинга: ${vector.length}`);
  }

  return new Float32Array(vector);
}

async function getQueryEmbedding(
  query: string,
  apiKey: string
): Promise<Float32Array | null> {
  try {
    return await fetchEmbedding(query, apiKey);
  } catch (error) {
    console.error("🔍 pgvector: не удалось получить эмбеддинг запроса", error);
    return null;
  }
}

function toVectorString(embedding: Float32Array): string {
  return `[${Array.from(embedding).join(",")}]`;
}

const RAG_SUBSCRIPTION_TYPES = new Set(["dialog", "history", "story", "universe"]);

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
  return isRagEligible(subscriptionType, subscriptionActive) || MESSAGE_EMBEDDINGS_ENABLED;
}

export function formatRagContext(messages: RagMessage[]): RagContext | null {
  if (!messages || messages.length === 0) {
    return null;
  }

  const text = messages
    .map((message) => {
      const speaker = message.role === "user" ? "Пользователь" : "Персонаж";
      return `- ${speaker}: ${message.content}`;
    })
    .join("\n");

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

export async function saveMessageEmbedding(
  messageId: string,
  embedding: Float32Array
): Promise<void> {
  if (!embedding || embedding.length === 0) {
    return;
  }

  try {
    const vectorString = toVectorString(embedding);

    await prisma.$executeRaw`
      INSERT INTO "MessageEmbedding" ("id", "messageId", embedding, "createdAt")
      VALUES (gen_random_uuid()::text, ${messageId}, ${vectorString}::vector, NOW())
    `;

    console.log(
      `🔍 Эмбеддинг сохранён для message=${messageId} (${embedding.length} dims)`
    );
  } catch (error) {
    console.error(`🔍 Ошибка эмбеддинга message=${messageId}:`, error);
  }
}

async function saveMessageEmbeddingFromContent(
  messageId: string,
  content: string,
  apiKey: string
): Promise<void> {
  const existing = await prisma.messageEmbedding.findUnique({
    where: { messageId },
    select: { id: true },
  });

  if (existing) {
    console.log(`🔍 Эмбеддинг уже есть для message=${messageId}`);
    return;
  }

  const embedding = await fetchEmbedding(content, apiKey);
  await saveMessageEmbedding(messageId, embedding);
}

export function scheduleMessageEmbedding(
  messageId: string,
  content: string,
  apiKey: string,
  persistEmbeddings: boolean
): void {
  if (!persistEmbeddings) {
    return;
  }

  void saveMessageEmbeddingFromContent(messageId, content, apiKey).catch((error) => {
    console.error(`🔍 Ошибка эмбеддинга message=${messageId}:`, error);
  });
}

export async function searchRelevantMessages(
  userId: string,
  characterId: string,
  queryText: string,
  apiKey: string,
  excludeMessageId?: string,
  limit: number = RAG_TOP_K,
  threshold: number = RAG_MIN_SIMILARITY
): Promise<RagMessage[]> {
  try {
    const queryEmbedding = await getQueryEmbedding(queryText, apiKey);
    if (!queryEmbedding) {
      return [];
    }

    const vectorString = toVectorString(queryEmbedding);

    const results = excludeMessageId
      ? await prisma.$queryRaw<RagSearchRow[]>`
          SELECT
            m.id,
            m.role,
            m.content,
            1 - (me.embedding <=> ${vectorString}::vector) AS similarity
          FROM "MessageEmbedding" me
          JOIN "Message" m ON m.id = me."messageId"
          WHERE
            m."characterId" = ${characterId}
            AND m."userId" = ${userId}
            AND m."role" = 'user'
            AND m.id != ${excludeMessageId}
          ORDER BY me.embedding <=> ${vectorString}::vector
          LIMIT ${limit}
        `
      : await prisma.$queryRaw<RagSearchRow[]>`
          SELECT
            m.id,
            m.role,
            m.content,
            1 - (me.embedding <=> ${vectorString}::vector) AS similarity
          FROM "MessageEmbedding" me
          JOIN "Message" m ON m.id = me."messageId"
          WHERE
            m."characterId" = ${characterId}
            AND m."userId" = ${userId}
            AND m."role" = 'user'
          ORDER BY me.embedding <=> ${vectorString}::vector
          LIMIT ${limit}
        `;

    const filtered = results.filter((row) => Number(row.similarity) > threshold);

    console.log(
      `🔍 RAG: найдено ${filtered.length} релевантных сообщений (проверено ${results.length})`
    );

    return filtered.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      similarity: Number(row.similarity),
    }));
  } catch (error) {
    console.error("🔍 RAG: ошибка поиска релевантных сообщений", error);
    return [];
  }
}
