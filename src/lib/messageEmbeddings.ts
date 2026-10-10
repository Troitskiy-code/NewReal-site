import { meteredPost } from "@/lib/aiCostTelemetry";
import { prisma } from "@/lib/prisma";
import { debugLog, errorLog, toSafeDiagnostic } from "@/lib/logger";
import { formatRagLine, selectDiverseRagCandidates, type RagMessage, type RagSourceMessage } from "./ragRetrieval";
export { formatRagLine } from "./ragRetrieval";
export type { RagMessage } from "./ragRetrieval";
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

export type RagContext = {
  text: string;
  count: number;
};

type RagSearchRow = {
  id: string;
  role: string;
  content: string;
  similarity: number;
  createdAt: Date;
};

type RagNeighborRow = RagSourceMessage & { anchorId: string; createdAt: Date };

export type RagSearchOptions = {
  /** Actual question, before adding nearby context; used for deterministic ranking. */
  currentQuery?: string;
  excludedMessageIds?: string[];
  /** Snapshot upper bound, also prevents future replies returning during regeneration. */
  throughMessage?: { id: string; createdAt: Date };
  before?: Date | null;
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
  threshold: number = RAG_MIN_SIMILARITY,
  options: RagSearchOptions = {}
): Promise<RagMessage[]> {
  try {
    const anchorLimit = Math.min(10, Math.max(0, Math.floor(limit)));
    if (!anchorLimit || !queryText.trim()) return [];
    const queryEmbedding = await getQueryEmbedding(queryText, apiKey);
    if (!queryEmbedding) {
      return [];
    }

    const vectorString = toVectorString(queryEmbedding);
    const excludedIds = [...new Set([...(options.excludedMessageIds ?? []), ...(excludeMessageId ? [excludeMessageId] : [])])];
    const throughAt = options.throughMessage?.createdAt ?? null;
    const throughId = options.throughMessage?.id ?? "";
    const beforeAt = options.before ?? null;
    const candidateLimit = Math.min(40, anchorLimit * 4);
    const results = await prisma.$queryRaw<RagSearchRow[]>`
      SELECT m.id, m.role, m.content, m."createdAt",
        1 - (me.embedding <=> ${vectorString}::vector) AS similarity
      FROM "MessageEmbedding" me JOIN "Message" m ON m.id = me."messageId"
      WHERE m."characterId" = ${characterId} AND m."userId" = ${userId}
        AND m.role IN ('user', 'assistant') AND NOT (m.id = ANY(${excludedIds}::text[]))
        AND (${throughAt}::timestamp IS NULL OR (m."createdAt", m.id) <= (${throughAt}::timestamp, ${throughId}))
        AND (${beforeAt}::timestamp IS NULL OR m."createdAt" < ${beforeAt}::timestamp)
      ORDER BY me.embedding <=> ${vectorString}::vector, m."createdAt" DESC, m.id DESC
      LIMIT ${candidateLimit}
    `;
    const candidates = results.map(row => ({ ...row, similarity: Number(row.similarity) }))
      .filter(row => Number.isFinite(row.similarity) && row.similarity > threshold);
    if (!candidates.length) return [];
    const anchorIds = candidates.map(row => row.id);
    // One batched read, independent of embeddings: an unembedded neighbouring reply
    // can be the acceptance, correction or cancellation that gives the anchor meaning.
    const neighbors = await prisma.$queryRaw<RagNeighborRow[]>`
      WITH ordered AS (
        SELECT m.id,
          LAG(m.id) OVER (ORDER BY m."createdAt", m.id) AS "previousId",
          LEAD(m.id) OVER (ORDER BY m."createdAt", m.id) AS "nextId"
        FROM "Message" m
        WHERE m."userId" = ${userId} AND m."characterId" = ${characterId}
          AND m.role IN ('user', 'assistant') AND NOT (m.id = ANY(${excludedIds}::text[]))
          AND (${throughAt}::timestamp IS NULL OR (m."createdAt", m.id) <= (${throughAt}::timestamp, ${throughId}))
          AND (${beforeAt}::timestamp IS NULL OR m."createdAt" < ${beforeAt}::timestamp)
      )
      SELECT o.id AS "anchorId", s.id, s.role, s.content, s."createdAt"
      FROM ordered o CROSS JOIN LATERAL (VALUES (o."previousId"), (o.id), (o."nextId")) AS neighbor(id)
      JOIN "Message" s ON s.id = neighbor.id
      WHERE o.id = ANY(${anchorIds}::text[])
      ORDER BY o.id, s."createdAt", s.id
    `;

    const enriched = candidates.flatMap(row => {
      const context = neighbors.filter(source => source.anchorId === row.id);
      // A rewrite/delete between reads must not return a stale anchor quotation.
      if (!context.some(source => source.id === row.id && source.content === row.content)) return [];
      return [{ ...row, context }];
    });
    const selected = selectDiverseRagCandidates(enriched, options.currentQuery ?? queryText, anchorLimit, threshold);
    debugLog("RAG", `найдено ${selected.length} фрагментов (проверено ${results.length} кандидатов)`);
    return selected;
  } catch (error) {
    errorLog("RAG", "ошибка поиска релевантных сообщений", toSafeDiagnostic(error));
    return [];
  }
}
