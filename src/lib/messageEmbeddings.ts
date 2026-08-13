import axios from "axios";
import { prisma } from "@/lib/prisma";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";

export const MESSAGE_EMBEDDINGS_ENABLED =
  process.env.ENABLE_RAG_EMBEDDINGS === "true";

function vectorToBytes(vector: number[]): Buffer {
  const float32 = new Float32Array(vector);
  return Buffer.from(float32.buffer);
}

async function fetchEmbedding(text: string, apiKey: string): Promise<number[]> {
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

  return vector;
}

export async function saveMessageEmbedding(
  messageId: string,
  content: string,
  apiKey: string
): Promise<void> {
  if (!MESSAGE_EMBEDDINGS_ENABLED) {
    return;
  }

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
  apiKey: string
): void {
  if (!MESSAGE_EMBEDDINGS_ENABLED) {
    return;
  }

  void saveMessageEmbedding(messageId, content, apiKey).catch((error) => {
    console.error(`🔍 Ошибка эмбеддинга message=${messageId}:`, error);
  });
}
