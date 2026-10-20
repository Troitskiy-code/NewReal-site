// TEMPORARY (2026-10-20): one-off production latency comparison of DeepInfra embedding models
// for the RAG query path. Remove together with /api/admin/embedding-probe and /admin/embedding-probe
// once the measurement is recorded.
import { randomUUID } from "node:crypto";
import axios from "axios";
import { providerApiKey } from "./aiProviders";
import { deepinfraAxiosOptions, deepinfraRequestPlan } from "./deepinfraNetwork";
import { DEEPINFRA_EMBEDDING_MODEL, DEEPINFRA_EMBEDDING_URL } from "./embeddingProviders";
import { toSafeDiagnostic } from "./logger";

export const EMBEDDING_PROBE_MODELS = [
  DEEPINFRA_EMBEDDING_MODEL,
  "Qwen/Qwen3-Embedding-4B",
  "Qwen/Qwen3-Embedding-8B",
  "BAAI/bge-m3",
  "BAAI/bge-m3-multi",
  "intfloat/multilingual-e5-large",
  "google/embeddinggemma-300m",
] as const;
const QUERY_INSTRUCTION = "Instruct: Given a question about a roleplay conversation, retrieve messages that contain the facts needed to answer it.\nQuery: ";
// Synthetic questions shaped like real RAG queries; no customer text is ever sent.
const QUESTIONS = [
  "Где мы оставили ключ от башни?", "Что обещал капитан перед штормом?", "Как зовут хозяйку таверны?",
  "Почему мы поссорились у старого моста?", "Сколько монет осталось после рынка?", "Куда ушёл проводник ночью?",
  "Что было написано в письме с печатью?", "Кто первым заметил дым над лесом?", "Какой подарок я принёс на праздник?",
  "Когда мы договорились встретиться снова?", "Что случилось с лодкой у причала?", "Зачем мы искали карту маяка?",
  "Какое имя ты дал своему коню?", "Что сказал стражник у северных ворот?", "Где спрятан второй фонарь?",
  "О чём мы спорили за ужином вчера?", "Кто помог нам выбраться из пещеры?", "Какую песню ты пела у костра?",
  "Сколько дней пути до столицы?", "Что я забыл в комнате на втором этаже?",
];
export const PROBE_LIMITS = { minRounds: 10, maxRounds: 100, defaultRounds: 80, requestTimeoutMs: 15_000, roundPauseMs: 1_000 };
const RETAIN_MS = 60 * 60_000;

type Sample = { ms: number; outcome: "ok" | "http" | "timeout" | "network"; status: number | null };
type ModelResult = { model: string; samples: Sample[]; dimensions: number | null; inputTokens: number; providerCostUsd: number;
  errorCodes: Record<string, number> };
export type EmbeddingProbeJob = { id: string; state: "running" | "finished" | "failed"; rounds: number; completedRounds: number;
  startedAt: number; finishedAt: number | null; networkRoute: string; results: ModelResult[] };
let current: EmbeddingProbeJob | null = null;
export class EmbeddingProbeBusyError extends Error {}
export class EmbeddingProbeConfigurationError extends Error {}

function configured() {
  try { providerApiKey("deepinfra"); return true; } catch { return false; }
}

export function reserveEmbeddingProbe(rounds: unknown): EmbeddingProbeJob {
  if (!configured()) throw new EmbeddingProbeConfigurationError();
  const count = rounds === undefined ? PROBE_LIMITS.defaultRounds : rounds;
  if (!Number.isSafeInteger(count) || (count as number) < PROBE_LIMITS.minRounds || (count as number) > PROBE_LIMITS.maxRounds) {
    throw new EmbeddingProbeConfigurationError();
  }
  if (current?.state === "running") throw new EmbeddingProbeBusyError();
  current = { id: randomUUID(), state: "running", rounds: count as number, completedRounds: 0, startedAt: Date.now(), finishedAt: null,
    networkRoute: deepinfraRequestPlan(DEEPINFRA_EMBEDDING_URL).route,
    results: EMBEDDING_PROBE_MODELS.map(model => ({ model, samples: [], dimensions: null, inputTokens: 0, providerCostUsd: 0, errorCodes: {} })) };
  return current;
}

/** Same URL, proxy plan and keep-alive agent as the production embedding client, but it never
 * changes the shared route circuit and writes no AiCostEvent rows (they would skew prod stats). */
async function probeOnce(model: string, input: string, key: string, result: ModelResult) {
  const started = Date.now();
  try {
    const plan = deepinfraRequestPlan(DEEPINFRA_EMBEDDING_URL);
    const response = await axios.post(DEEPINFRA_EMBEDDING_URL, { model, input: [input], encoding_format: "float" }, {
      ...deepinfraAxiosOptions(DEEPINFRA_EMBEDDING_URL, plan), maxRedirects: 0, timeout: PROBE_LIMITS.requestTimeoutMs,
      signal: AbortSignal.timeout(PROBE_LIMITS.requestTimeoutMs),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } });
    const ms = Date.now() - started;
    const vector = response.data?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.length) throw Object.assign(new Error("Invalid embedding"), { code: "INVALID_VECTOR" });
    result.dimensions = vector.length;
    const usage = response.data?.usage;
    if (Number.isFinite(usage?.prompt_tokens)) result.inputTokens += usage.prompt_tokens;
    if (Number.isFinite(usage?.estimated_cost)) result.providerCostUsd += usage.estimated_cost;
    result.samples.push({ ms, outcome: "ok", status: response.status });
  } catch (error) {
    const ms = Date.now() - started;
    const status = axios.isAxiosError(error) ? error.response?.status ?? null : null;
    const safe = toSafeDiagnostic(error);
    const code = typeof safe.code === "string" ? safe.code : status ? `HTTP_${status}` : "unknown";
    result.errorCodes[code] = (result.errorCodes[code] ?? 0) + 1;
    result.samples.push({ ms, status, outcome: status ? "http" : code === "ERR_CANCELED" || code === "ECONNABORTED" ? "timeout" : "network" });
  }
}

const shuffle = <T,>(items: T[]) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
};

export async function executeEmbeddingProbe(job: EmbeddingProbeJob) {
  if (job !== current || job.state !== "running") return;
  try {
    const key = providerApiKey("deepinfra");
    for (let round = 0; round < job.rounds; round++) {
      // Interleaved, randomized order: every model sees the same provider/network moment.
      const question = QUESTIONS[round % QUESTIONS.length];
      for (const result of shuffle(job.results)) {
        // A model rejected outright (unknown id, no access) stops after three answers.
        const rejected = result.samples.length >= 3 && result.samples.every(sample => sample.status !== null && sample.status >= 400 && sample.status !== 429);
        if (rejected) continue;
        const instructed = result.model.startsWith("Qwen/") ? QUERY_INSTRUCTION + question
          : result.model.startsWith("intfloat/") ? `query: ${question}` : question;
        await probeOnce(result.model, instructed, key, result);
      }
      job.completedRounds = round + 1;
      await new Promise(resolve => setTimeout(resolve, PROBE_LIMITS.roundPauseMs));
    }
    job.state = "finished";
  } catch { job.state = "failed"; }
  finally { job.finishedAt = Date.now(); }
}

const percentile = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
export function summarizeModel(result: ModelResult) {
  const ok = result.samples.filter(sample => sample.outcome === "ok").map(sample => sample.ms).sort((a, b) => a - b);
  // Failures count as slower than every threshold they reached, so tails are not hidden.
  const all = result.samples.map(sample => sample.outcome === "ok" ? sample.ms : Number.POSITIVE_INFINITY);
  const over = (ms: number) => all.length ? Math.round(1000 * all.filter(value => value > ms).length / all.length) / 10 : null;
  return { model: result.model, sent: result.samples.length, ok: ok.length,
    http429: result.samples.filter(sample => sample.status === 429).length,
    timeouts: result.samples.filter(sample => sample.outcome === "timeout").length,
    otherErrors: result.samples.filter(sample => sample.outcome !== "ok" && sample.status !== 429 && sample.outcome !== "timeout").length,
    errorCodes: result.errorCodes, dimensions: result.dimensions,
    p10: percentile(ok, .1), p50: percentile(ok, .5), p90: percentile(ok, .9), p95: percentile(ok, .95), p99: percentile(ok, .99), max: ok.at(-1) ?? null,
    pctOver1s: over(1000), pctOver3s: over(3000), pctOver5s: over(5000),
    inputTokens: result.inputTokens, providerCostUsd: Math.round(result.providerCostUsd * 1e9) / 1e9,
    samplesMs: result.samples.map(sample => sample.outcome === "ok" ? sample.ms : -sample.ms) };
}

export function embeddingProbeStatus() {
  if (current?.finishedAt && Date.now() - current.finishedAt > RETAIN_MS) current = null;
  return { configured: configured(), models: EMBEDDING_PROBE_MODELS, limits: PROBE_LIMITS,
    networkRoute: deepinfraRequestPlan(DEEPINFRA_EMBEDDING_URL).route,
    job: current && { id: current.id, state: current.state, rounds: current.rounds, completedRounds: current.completedRounds,
      startedAt: current.startedAt, finishedAt: current.finishedAt, networkRoute: current.networkRoute,
      results: current.results.map(summarizeModel) } };
}
