import axios from "axios";
import { meteredPost, SupersededRequestError } from "./aiCostTelemetry";
import { embeddingTransport, EMBEDDING_BACKGROUND_TIMEOUT_MS } from "./embeddingProviders";
import { infoLog } from "./logger";

type EmbeddingResponse = { model?: string; data?: Array<{ index: number; embedding: number[] }> };
export type EmbeddingTask = "document" | "query" | "dedup";
const QUERY_INSTRUCTION = "Instruct: Given a question about a roleplay conversation, retrieve messages that contain the facts needed to answer it.\nQuery: ";
// DeepInfra answers 429 for a busy shared embedding model within ~0.2–1.1 s (prod logs 2026-10-20).
// One retry is sent only if it can still finish inside the caller's budget.
const RATE_LIMIT_RETRY_DELAY_MS = 250;
const MIN_RETRY_BUDGET_MS = 500;
// Slow answers are DeepInfra queueing (median ~0.5–1 s, ~15% over 3 s). An interactive query
// still waiting after this delay gets a parallel duplicate; the first answer wins, the other is cancelled.
export const QUERY_HEDGE_DELAY_MS = 1500;

/** Delay before the single retry of a rate-limited batch, or null when it must not be retried. */
function rateLimitRetryDelay(error: unknown): number | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 429) return null;
  const header = error.response.headers?.["retry-after"];
  const seconds = typeof header === "string" && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : null;
  return seconds === null ? RATE_LIMIT_RETRY_DELAY_MS : Math.ceil(seconds * 1000);
}

type Attempt = "primary" | "hedge" | "retry";
/** Runs one batch: a primary attempt, an optional hedge, and at most one 429 retry, all inside `deadline`. */
function settleBatch<T>(post: (signal: AbortSignal, timeout: number) => Promise<T>, deadline: number, hedgeAfterMs: number | null) {
  return new Promise<{ response: T; attempts: Attempt[]; winner: Attempt }>((resolve, reject) => {
    const controllers: AbortController[] = [], attempts: Attempt[] = [];
    let running = 0, settled = false, retried = false, waiting = false, hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastError: unknown = new Error("Embedding deadline exceeded");
    const finishWith = (error: unknown) => {
      // Fail only when nothing can still answer: no running attempt, pending retry or hedge.
      if (settled || running > 0 || waiting || hedgeTimer) return;
      settled = true; reject(error);
    };
    const start = (kind: Attempt) => {
      const remaining = deadline - Date.now();
      if (settled) return;
      if (remaining <= 0) { finishWith(lastError); return; }
      const controller = new AbortController();
      controllers.push(controller); attempts.push(kind); running++;
      post(AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]), remaining).then(response => {
        running--;
        if (settled) return;
        settled = true; clearTimeout(hedgeTimer);
        for (const other of controllers) if (other !== controller) other.abort(new SupersededRequestError());
        resolve({ response, attempts, winner: kind });
      }, error => {
        running--; lastError = error;
        if (settled) return;
        const delay = rateLimitRetryDelay(error);
        if (delay !== null && !retried && deadline - Date.now() - delay >= MIN_RETRY_BUDGET_MS) {
          retried = true; waiting = true;
          setTimeout(() => { waiting = false; start("retry"); }, delay);
          return;
        }
        // A non-retryable primary failure is final; do not keep a hedge alive just to repeat it.
        if (running === 0 && !waiting) { clearTimeout(hedgeTimer); hedgeTimer = undefined; }
        finishWith(error);
      });
    };
    if (hedgeAfterMs !== null) {
      hedgeTimer = setTimeout(() => {
        hedgeTimer = undefined;
        if (!settled && running > 0 && deadline - Date.now() >= MIN_RETRY_BUDGET_MS) start("hedge");
        else finishWith(lastError);
      }, hedgeAfterMs);
    }
    start("primary");
  });
}

/** All rows in a call share one vector space; never fall back to a different provider. */
export async function fetchTextEmbeddings(inputs: string[], legacyKey: string, task: EmbeddingTask,
  timeoutMs = EMBEDDING_BACKGROUND_TIMEOUT_MS) {
  const route = embeddingTransport(legacyKey);
  if (inputs.some(input => !input.trim() || input.length > 64_000)) throw new Error("Invalid embedding input");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error("Invalid embedding timeout");
  const started = Date.now(), deadline = started + timeoutMs;
  const vectors: number[][] = [];
  // Bound batch size and TOTAL wait, rather than giving every chunk a fresh timeout.
  for (let offset = 0; offset < inputs.length; offset += 32) {
    if (deadline - Date.now() <= 0) throw new Error("Embedding deadline exceeded");
    const batch = inputs.slice(offset, offset + 32).map(text => route.provider === "deepinfra" && task === "query" ? QUERY_INSTRUCTION + text : text);
    const post = (signal: AbortSignal, timeout: number) => meteredPost<EmbeddingResponse>("embedding", route.url, {
      model: route.model, input: batch, encoding_format: "float",
    }, { headers: { Authorization: `Bearer ${route.apiKey}`, "Content-Type": "application/json" },
      timeout, signal, maxRedirects: 0 });
    // Only the interactive RAG query is hedged; background batches can wait.
    const hedgeAfter = task === "query" && timeoutMs > QUERY_HEDGE_DELAY_MS + MIN_RETRY_BUDGET_MS ? QUERY_HEDGE_DELAY_MS : null;
    let outcome: Awaited<ReturnType<typeof settleBatch<Awaited<ReturnType<typeof post>>>>>;
    try {
      outcome = await settleBatch(post, deadline, hedgeAfter);
    } catch (error) {
      if (task === "query") infoLog("Embedding", "query attempts exhausted", { durationMs: Date.now() - started, budgetMs: timeoutMs });
      throw error;
    }
    if (outcome.attempts.length > 1) {
      infoLog("Embedding", "query settled after extra attempt", { task, winner: outcome.winner, attempts: outcome.attempts.join("+"),
        durationMs: Date.now() - started, budgetMs: timeoutMs });
    }
    const response = outcome.response;
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
