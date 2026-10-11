import { meteredPost } from "./aiCostTelemetry";
import { embeddingTransport, EMBEDDING_BACKGROUND_TIMEOUT_MS } from "./embeddingProviders";

type EmbeddingResponse = { model?: string; data?: Array<{ index: number; embedding: number[] }> };
export type EmbeddingTask = "document" | "query" | "dedup";
const QUERY_INSTRUCTION = "Instruct: Given a question about a roleplay conversation, retrieve messages that contain the facts needed to answer it.\nQuery: ";

/** All rows in a call share one vector space; never fall back to a different provider. */
export async function fetchTextEmbeddings(inputs: string[], legacyKey: string, task: EmbeddingTask,
  timeoutMs = EMBEDDING_BACKGROUND_TIMEOUT_MS) {
  const route = embeddingTransport(legacyKey);
  if (inputs.some(input => !input.trim() || input.length > 64_000)) throw new Error("Invalid embedding input");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error("Invalid embedding timeout");
  const deadline = Date.now() + timeoutMs;
  const vectors: number[][] = [];
  // Bound batch size and TOTAL wait, rather than giving every chunk a fresh timeout.
  for (let offset = 0; offset < inputs.length; offset += 32) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Embedding deadline exceeded");
    const batch = inputs.slice(offset, offset + 32).map(text => route.provider === "deepinfra" && task === "query" ? QUERY_INSTRUCTION + text : text);
    const response = await meteredPost<EmbeddingResponse>("embedding", route.url, {
      model: route.model, input: batch, encoding_format: "float",
    }, { headers: { Authorization: `Bearer ${route.apiKey}`, "Content-Type": "application/json" },
      timeout: remaining, signal: AbortSignal.timeout(remaining), maxRedirects: 0 });
    const rows = response.data?.data;
    const actualModel = response.data?.model;
    const legacyAlias = route.provider === "kodikrouter" && actualModel === "text-embedding-3-small";
    if (actualModel && actualModel !== route.model && !legacyAlias) throw new Error("Unexpected embedding model");
    if (!Array.isArray(rows) || rows.length !== batch.length) throw new Error("Incomplete embedding response");
    const ordered: number[][] = new Array(batch.length);
    for (const row of rows) {
      if (!Number.isInteger(row.index) || row.index < 0 || row.index >= batch.length || ordered[row.index]) throw new Error("Invalid embedding index");
      const vector = row.embedding;
      if (!Array.isArray(vector) || vector.length !== route.dimensions
        || vector.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1_000_000)
        || !vector.some(n => n !== 0)) throw new Error("Invalid embedding vector");
      ordered[row.index] = vector;
    }
    vectors.push(...ordered);
  }
  return { provider: route.provider, vectors };
}
