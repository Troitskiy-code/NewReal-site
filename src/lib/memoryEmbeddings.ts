import { meteredPost } from "@/lib/aiCostTelemetry";
import { debugLog, errorLog, toSafeDiagnostic } from "./logger";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const DEFAULT_DEDUP_THRESHOLD = 0.8;

function parseDedupThreshold(): number {
  const parsed = Number.parseFloat(process.env['MEMORY_DEDUP_THRESHOLD'] || "0.80");
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    return DEFAULT_DEDUP_THRESHOLD;
  }
  return parsed;
}

export const SEMANTIC_DEDUP_THRESHOLD = parseDedupThreshold();

export function isMemoryDedupDebugEnabled(): boolean {
  return process.env['DEBUG'] === "true";
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function keyTokenStem(token: string): string {
  // Full names must not collide merely because their first four letters match.
  // A conservative terminal vowel normalization handles e.g. Лукас/Лукаса.
  return token.toLowerCase().replace(/ё/g, "е").replace(/^(.{5,})[ауюы]$/u, "$1");
}

/**
 * Names, numbers and explicit negation. Similar vectors are not proof of identical
 * facts. Prefer retaining a possible duplicate to erasing a changed name or denial.
 */
export function extractKeyTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*|[.!?…:;]/gu) ?? [];
  for (const word of words) {
    if (/^[.!?…:;]$/.test(word)) {
      continue;
    }
    if (/^\p{N}+$/u.test(word)) tokens.add(word);
    else if (/^\p{Lu}/u.test(word)) tokens.add(keyTokenStem(word));
    if (/^(?:не|нет|без|никогда|not|no|never|without)$/iu.test(word)) tokens.add("!negation");
  }
  return tokens;
}

export function hasDistinctKeyTokens(left: string, right: string): boolean {
  const a = extractKeyTokens(left);
  const b = extractKeyTokens(right);
  if (a.size !== b.size) return true;
  for (const token of a) if (!b.has(token)) return true;
  return false;
}

export function keepUniqueByCosine(
  items: string[],
  embeddings: number[][],
  threshold = SEMANTIC_DEDUP_THRESHOLD
): string[] {
  const result: string[] = [];
  const keptEmbeddings: number[][] = [];

  for (let i = 0; i < items.length; i++) {
    const embedding = embeddings[i];
    if (!embedding) continue;
    const isDuplicate = keptEmbeddings.some(
      (kept, keptIndex) => cosineSimilarity(embedding, kept) > threshold && !hasDistinctKeyTokens(items[i], result[keptIndex])
    );
    if (!isDuplicate) {
      result.push(items[i]);
      keptEmbeddings.push(embedding);
    }
  }

  return result;
}

export function formatSimilarityMatrix(
  embeddings: number[][],
  threshold = SEMANTIC_DEDUP_THRESHOLD
): string[] {
  const rows: string[] = [];
  for (let i = 0; i < embeddings.length; i++) {
    const left = embeddings[i];
    if (!left) continue;
    for (let j = i + 1; j < embeddings.length; j++) {
      const right = embeddings[j];
      if (!right) continue;
      const score = cosineSimilarity(left, right);
      const mark = score > threshold ? " ← если > threshold, дедуплицируем" : "";
      rows.push(`  [${i}-${j}]: ${score.toFixed(2)}${mark}`);
    }
  }
  return rows;
}

export function logSimilarityMatrix(
  embeddings: number[][],
  threshold = SEMANTIC_DEDUP_THRESHOLD
) {
  if (!isMemoryDedupDebugEnabled()) return;

  const rows = formatSimilarityMatrix(embeddings, threshold);
  if (rows.length === 0) return;
  debugLog("Memory:Dedup", `Similarity matrix:\n${rows.join("\n")}`);
}

export async function fetchEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await meteredPost("embedding",
    `${KODIKROUTER_URL}/embeddings`,
    {
      model: EMBEDDING_MODEL,
      input: texts,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const rows = response.data?.data;
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw new Error("Неполный ответ эмбеддингов");
  }

  return [...rows]
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    .map((row) => {
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
        throw new Error("Пустой эмбеддинг от API");
      }
      return row.embedding as number[];
    });
}

/** true/false when embeddings answered; null when the provider failed and the caller must fall back. */
export async function isSemanticDuplicate(
  candidate: string,
  existing: string[],
  apiKey: string,
  threshold = SEMANTIC_DEDUP_THRESHOLD
): Promise<boolean | null> {
  if (!candidate.trim() || existing.length === 0) return false;

  try {
    const [candidateEmbedding, ...kept] = await fetchEmbeddings([candidate, ...existing], apiKey);
    if (!candidateEmbedding) return null;
    return kept.some(
      (embedding, index) => cosineSimilarity(candidateEmbedding, embedding) > threshold && !hasDistinctKeyTokens(candidate, existing[index])
    );
  } catch (error) {
    errorLog("Memory:Dedup", "embedding compare failed", toSafeDiagnostic(error));
    return null;
  }
}

export async function maxSimilarityAgainst(
  candidate: string,
  existing: string[],
  apiKey: string
): Promise<number | null> {
  if (!candidate.trim() || existing.length === 0) return 0;

  try {
    const embeddings = await fetchEmbeddings([candidate, ...existing], apiKey);
    const [candidateEmbedding, ...kept] = embeddings;
    if (!candidateEmbedding) return null;

    let best = 0;
    for (const embedding of kept) {
      const score = cosineSimilarity(candidateEmbedding, embedding);
      if (score > best) best = score;
    }
    return best;
  } catch (error) {
    errorLog("Memory:Dedup", "embedding compare failed", toSafeDiagnostic(error));
    return null;
  }
}
