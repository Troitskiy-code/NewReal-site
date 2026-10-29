import { prisma } from "@/lib/prisma";
import { fetchTextEmbeddings } from "./embeddingClient";
import { getEmbeddingProvider } from "./embeddingProviders";
import { errorLog, infoLog, toSafeDiagnostic } from "./logger";

/**
 * Semantic search over memory events. Word overlap missed answers worded differently from the question
 * («кто меня нанял» / «договорились, господин Вельш»): on the crash-test probes it found 11 of 19 stored
 * answers, word overlap plus these similarities 16 (eval 2026-10-29). Vectors live in the
 * Qwen3-Embedding-0.6B space of MessageEmbeddingDeepinfra; other providers keep word overlap only.
 */
const QUERY_TIMEOUT_MS = 1200;
/** Events embedded per chat turn, newest first: old stories catch up in the background. */
const BACKFILL_BATCH = 32;
let tableMissing = false;
const enabled = () => !tableMissing && getEmbeddingProvider() === "deepinfra";
const vector = (values: number[]) => `[${values.join(",")}]`;
function noteFailure(stage: string, error: unknown) {
  // Until the migration runs the table is absent: stop asking instead of failing every turn.
  if (/EpisodicEmbeddingDeepinfra/.test(String(error)) && /does not exist|42P01/.test(String(error))) tableMissing = true;
  errorLog("EpisodicSearch", `${stage} failed`, toSafeDiagnostic(error));
}

/** Similarity of every embedded event of the story to the user's message; empty when unavailable. */
export async function episodicSimilarities(threadId: string, query: string): Promise<Map<string, number>> {
  if (!enabled() || !query.trim()) return new Map();
  try {
    const { vectors } = await fetchTextEmbeddings([query.slice(0, 4000)], "", "query", QUERY_TIMEOUT_MS);
    const rows = await prisma.$queryRaw<Array<{ id: string; similarity: number }>>`
      SELECT e.id, 1 - (v.embedding <=> ${vector(vectors[0])}::vector) AS similarity
      FROM "EpisodicEmbeddingDeepinfra" v JOIN "EpisodicMemory" e ON e.id = v."episodicId"
      WHERE e."threadId" = ${threadId}`;
    return new Map(rows.map(row => [row.id, Number(row.similarity)]));
  } catch (error) {
    noteFailure("similarity", error);
    return new Map();
  }
}

/** Embeds up to BACKFILL_BATCH events of the story that have no vector yet; returns how many. */
export async function backfillEpisodicEmbeddings(threadId: string): Promise<number> {
  if (!enabled()) return 0;
  try {
    const rows = (await prisma.$queryRaw<Array<{ id: string; event: string }>>`
      SELECT e.id, e.event FROM "EpisodicMemory" e
      LEFT JOIN "EpisodicEmbeddingDeepinfra" v ON v."episodicId" = e.id
      WHERE e."threadId" = ${threadId} AND v.id IS NULL
      ORDER BY e.timestamp DESC LIMIT ${BACKFILL_BATCH}`).filter(row => row.event.trim());
    if (!rows.length) return 0;
    const { vectors } = await fetchTextEmbeddings(rows.map(row => row.event.slice(0, 4000)), "", "document");
    for (const [index, row] of rows.entries()) {
      await prisma.$executeRaw`
        INSERT INTO "EpisodicEmbeddingDeepinfra" ("id", "episodicId", embedding, "createdAt")
        VALUES (gen_random_uuid()::text, ${row.id}, ${vector(vectors[index])}::vector, NOW())
        ON CONFLICT ("episodicId") DO NOTHING`;
    }
    infoLog("EpisodicSearch", "events embedded", { count: rows.length });
    return rows.length;
  } catch (error) {
    noteFailure("backfill", error);
    return 0;
  }
}
