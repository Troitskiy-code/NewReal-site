import axios from "axios";
import { errorLog } from "./logger";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";

export const SEMANTIC_DEDUP_THRESHOLD = 0.85;

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
      (kept) => cosineSimilarity(embedding, kept) > threshold
    );
    if (!isDuplicate) {
      result.push(items[i]);
      keptEmbeddings.push(embedding);
    }
  }

  return result;
}

export async function fetchEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await axios.post(
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
    errorLog("Memory:Dedup", "embedding compare failed", error);
    return null;
  }
}
