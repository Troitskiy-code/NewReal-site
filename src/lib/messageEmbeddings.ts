import axios from "axios";
import { prisma } from "@/lib/prisma";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
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

function vectorToBytes(vector: number[] | Float32Array): Buffer {
  const float32 = vector instanceof Float32Array ? vector : new Float32Array(vector);
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

function bytesToFloat32Array(bytes: Buffer): Float32Array {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    normLeft += left[index] * left[index];
    normRight += right[index] * right[index];
  }

  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight) + 1e-8);
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

  return new Float32Array(vector);
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

  await prisma.messageEmbedding.create({
    data: {
      messageId,
      embedding: vectorToBytes(vector),
    },
  });

  console.log(`🔍 Эмбеддинг сохранён для message=${messageId} (${vector.length} dims)`);
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
  excludeMessageId?: string
): Promise<RagMessage[]> {
  const queryVector = await fetchEmbedding(queryText, apiKey);

  const storedEmbeddings = await prisma.messageEmbedding.findMany({
    where: {
      message: {
        userId,
        characterId,
        ...(excludeMessageId ? { id: { not: excludeMessageId } } : {}),
      },
    },
    select: {
      embedding: true,
      message: {
        select: {
          id: true,
          role: true,
          content: true,
        },
      },
    },
  });

  const ranked = storedEmbeddings
    .map((entry) => ({
      id: entry.message.id,
      role: entry.message.role,
      content: entry.message.content,
      similarity: cosineSimilarity(queryVector, bytesToFloat32Array(entry.embedding)),
    }))
    .filter((entry) => entry.similarity > RAG_MIN_SIMILARITY)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, RAG_TOP_K);

  console.log(
    `🔍 RAG: найдено ${ranked.length} релевантных сообщений (проверено ${storedEmbeddings.length})`
  );

  return ranked;
}
