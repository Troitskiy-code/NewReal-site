import { meteredPost } from "@/lib/aiCostTelemetry";
import { prisma } from "@/lib/prisma";
import { debugLog, errorLog, toSafeDiagnostic } from "@/lib/logger";
import {
  isMessageEmbeddingsFlagEnabled,
  isRagEligible,
  shouldPersistEmbeddings,
} from "@/lib/ragEligibility";

export { isMessageEmbeddingsFlagEnabled, isRagEligible, shouldPersistEmbeddings };

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const RAG_TOP_K = 5;
const RAG_MIN_SIMILARITY = 0.25;
export const RAG_HISTORY_TOKEN_THRESHOLD = 3000;
/** The query embedding sits on the reply path; past this the chat continues without quotes. */
export const RAG_QUERY_EMBEDDING_TIMEOUT_MS = 3000;

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

export const MESSAGE_EMBEDDINGS_ENABLED = isMessageEmbeddingsFlagEnabled();

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

async function fetchEmbedding(text: string, apiKey: string, timeoutMs?: number): Promise<Float32Array> {
  const response = await meteredPost("embedding",
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
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
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
    return await fetchEmbedding(query, apiKey, RAG_QUERY_EMBEDDING_TIMEOUT_MS);
  } catch (error) {
    errorLog("RAG", "pgvector: не удалось получить эмбеддинг запроса", toSafeDiagnostic(error));
    return null;
  }
}

function toVectorString(embedding: Float32Array): string {
  return `[${Array.from(embedding).join(",")}]`;
}

export function formatRagLine(message: Pick<RagMessage, "role" | "content">, locale?: string): string {
  const english = locale === "en";
  const speaker = message.role === "user" ? (english ? "User" : "Пользователь") : english ? "Character" : "Персонаж";
  return `- ${speaker}: ${message.content.replace(/\s*\n\s*/g, " ").trim()}`;
}

export function formatRagContext(messages: RagMessage[], locale?: string): RagContext | null {
  if (!messages || messages.length === 0) {
    return null;
  }

  const text = messages.map((message) => formatRagLine(message, locale)).join("\n");
  return { text, count: messages.length };
}

export async function saveMessageEmbedding(
  messageId: string,
  embedding: Float32Array,
  sourceContent: string
): Promise<void> {
  if (!embedding || embedding.length === 0) {
    return;
  }

  try {
    const vectorString = toVectorString(embedding);

    // Keep the matching source row stable until the INSERT commits; a plain
    // snapshot check can race an update followed by embedding invalidation.
    const inserted = await prisma.$executeRaw`
      INSERT INTO "MessageEmbedding" ("id", "messageId", embedding, "createdAt")
      SELECT gen_random_uuid()::text, m.id, ${vectorString}::vector, NOW()
      FROM "Message" m
      WHERE m.id = ${messageId} AND m.content = ${sourceContent}
      FOR SHARE OF m
      ON CONFLICT ("messageId") DO NOTHING
    `;

    if (inserted > 0) debugLog(
      "RAG",
      `Эмбеддинг сохранён для message=${messageId} (${embedding.length} dims)`
    );
  } catch (error) {
    errorLog("RAG", `Ошибка эмбеддинга message=${messageId}:`, toSafeDiagnostic(error));
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
    debugLog("RAG", `Эмбеддинг уже есть для message=${messageId}`);
    return;
  }

  const embedding = await fetchEmbedding(content, apiKey);
  await saveMessageEmbedding(messageId, embedding, content);
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
    errorLog("RAG", `Ошибка эмбеддинга message=${messageId}:`, toSafeDiagnostic(error));
  });
}

/** Continue/regenerate rewrite a message in place; a vector of the old text would return stale quotes. */
export function scheduleMessageEmbeddingRefresh(
  messageId: string,
  content: string,
  apiKey: string,
  persistEmbeddings: boolean
): void {
  void (async () => {
    // Invalidate even after a plan change. A delayed refresh of an older version
    // must not erase the vector of the current text.
    await prisma.$executeRaw`
      WITH current_message AS (
        SELECT id FROM "Message" WHERE id = ${messageId} AND content = ${content} FOR SHARE
      )
      DELETE FROM "MessageEmbedding" me USING current_message m
      WHERE me."messageId" = m.id
    `;
    if (persistEmbeddings) await saveMessageEmbeddingFromContent(messageId, content, apiKey);
  })().catch((error) => {
    errorLog("RAG", `Ошибка обновления эмбеддинга message=${messageId}:`, toSafeDiagnostic(error));
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
            AND m."role" IN ('user', 'assistant')
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
            AND m."role" IN ('user', 'assistant')
          ORDER BY me.embedding <=> ${vectorString}::vector
          LIMIT ${limit}
        `;

    const filtered = results.filter((row) => Number(row.similarity) > threshold);

    debugLog(
      "RAG",
      `найдено ${filtered.length} релевантных сообщений (проверено ${results.length})`
    );

    return filtered.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      similarity: Number(row.similarity),
    }));
  } catch (error) {
    errorLog("RAG", "ошибка поиска релевантных сообщений", toSafeDiagnostic(error));
    return [];
  }
}
