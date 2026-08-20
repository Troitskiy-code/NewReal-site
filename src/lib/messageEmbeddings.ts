import axios from "axios";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const RAG_TOP_K = 5;
const RAG_MIN_SIMILARITY = 0.25;

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

function embeddingToPgVector(vector: number[] | Float32Array): string {
  return `[${Array.from(vector).join(",")}]`;
}

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

async function getQueryEmbedding(query: string, apiKey: string): Promise<string | null> {
  try {
    const vector = await fetchEmbedding(query, apiKey);
    return embeddingToPgVector(vector);
  } catch (error) {
    console.error("🔍 pgvector: не удалось получить эмбеддинг запроса", error);
    return null;
  }
}

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
  return isUniverseRagEligible(subscriptionType, subscriptionActive) || MESSAGE_EMBEDDINGS_ENABLED;
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

  const vector = await fetchEmbedding(content, apiKey);
  const vectorLiteral = embeddingToPgVector(vector);

  await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO "MessageEmbedding" (id, "messageId", embedding, "createdAt")
      VALUES (${randomUUID()}, ${messageId}, ${Prisma.raw(`${vectorLiteral}::vector`)}, NOW())
    `
  );

  console.log(`🔍 Эмбеддинг сохранён для message=${messageId} (${EMBEDDING_DIMENSIONS} dims)`);
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

  void saveMessageEmbedding(messageId, content, apiKey).catch((error) => {
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
  const queryEmbedding = await getQueryEmbedding(queryText, apiKey);
  if (!queryEmbedding) {
    return [];
  }

  const vectorParam = Prisma.raw(`${queryEmbedding}::vector`);

  const results = excludeMessageId
    ? await prisma.$queryRaw<RagSearchRow[]>(
        Prisma.sql`
        SELECT
          m.id,
          m.role,
          m.content,
          1 - (me.embedding <=> ${vectorParam}) AS similarity
        FROM "MessageEmbedding" me
        JOIN "Message" m ON m.id = me."messageId"
        WHERE
          m."characterId" = ${characterId}
          AND m."userId" = ${userId}
          AND m."role" = 'user'
          AND m.id != ${excludeMessageId}
        ORDER BY me.embedding <=> ${vectorParam}
        LIMIT ${limit}
      `
      )
    : await prisma.$queryRaw<RagSearchRow[]>(
        Prisma.sql`
        SELECT
          m.id,
          m.role,
          m.content,
          1 - (me.embedding <=> ${vectorParam}) AS similarity
        FROM "MessageEmbedding" me
        JOIN "Message" m ON m.id = me."messageId"
        WHERE
          m."characterId" = ${characterId}
          AND m."userId" = ${userId}
          AND m."role" = 'user'
        ORDER BY me.embedding <=> ${vectorParam}
        LIMIT ${limit}
      `
      );

  console.log(`🔍 pgvector: найдено ${results.length} релевантных сообщений`);

  return results
    .filter((row) => Number(row.similarity) > threshold)
    .map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      similarity: Number(row.similarity),
    }));
}
