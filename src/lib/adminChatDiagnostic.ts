import { randomUUID } from "node:crypto";
import { streamChatCompletion, type ChatCompletionMessage } from "./chatHelpers";
import { consumeOpenAIChatCompletion } from "./chatStreamDiagnostics";
import { ChatCompletionStreamParser, extractChatStreamDelta } from "./chatCompletionStream";
import { DEEPINFRA_CHAT_URL, getChatProvider, providerApiKey } from "./aiProviders";
import { deepinfraModel } from "./deepinfraModels";
import { chatModelGenerationOptions, chatModelStreamTimeouts } from "./testingChatModels";
import { safeProviderRequestId, safeTransportHeaders, withChatTransportObserver, chatTransportTraceEnabled } from "./aiTransportDiagnostics";
import { withInMemoryAiCostContext } from "./aiCostTelemetry";
import { toSafeDiagnostic } from "./logger";
import { deepinfraNetworkRoute, directDeepinfraFetch } from "./deepinfraNetwork";

export const ADMIN_DIAGNOSTIC_MODELS = [
  "deepinfra:mistralai/Mistral-Small-3.2-24B-Instruct-2506",
  "deepinfra:Qwen/Qwen3-235B-A22B-Instruct-2507",
] as const;
type SafeValue = string | number | boolean | null;
type Observation = Record<string, SafeValue>;
export type AdminDiagnosticJob = {
  id: string; model: string; state: "running" | "finished" | "failed";
  phase: "direct" | "pipeline" | "done"; startedAt: number; finishedAt: number | null;
  direct: Observation | null; pipeline: { outcome: string; durationMs: number; failure: Record<string, unknown> | null; attempts: Observation[]; observations: Observation[] } | null;
  observation: string | null;
  pipelineRoute: "direct" | "proxy";
  directClient: "node_fetch" | "undici";
};
let current: AdminDiagnosticJob | null = null;
const RETAIN_MS = 15 * 60_000;
const COOLDOWN_MS = 60_000;
export class DiagnosticBusyError extends Error {}
export class DiagnosticConfigurationError extends Error {}
export function adminDiagnosticStatus() {
  if (current?.finishedAt && Date.now() - current.finishedAt > RETAIN_MS) current = null;
  return { configured: getChatProvider() === "deepinfra" && Boolean(process.env['DEEPINFRA_API_KEY']?.trim()),
    traceEnabled: chatTransportTraceEnabled(), pipelineRoute: deepinfraNetworkRoute(), nodeVersion: process.version, maxProviderCalls: 3, job: current,
    cooldownRemainingMs: current?.finishedAt ? Math.max(0, COOLDOWN_MS - (Date.now() - current.finishedAt)) : 0 };
}
export function reserveAdminDiagnostic(model: unknown) {
  if (typeof model !== "string" || !(ADMIN_DIAGNOSTIC_MODELS as readonly string[]).includes(model)) throw new DiagnosticConfigurationError();
  const status = adminDiagnosticStatus();
  if (!status.configured) throw new DiagnosticConfigurationError();
  if (current?.state === "running" || status.cooldownRemainingMs > 0) throw new DiagnosticBusyError();
  current = { id: randomUUID(), model, state: "running", phase: "direct", startedAt: Date.now(), finishedAt: null,
    direct: null, pipeline: null, observation: null, pipelineRoute: deepinfraNetworkRoute(), directClient: deepinfraNetworkRoute() === "proxy" ? "undici" : "node_fetch" };
  return current;
}

// Only locally constructed numeric/allowlisted transport observations reach the browser.
const OBSERVATION_KEYS = new Set(["operationId", "costEventId", "attempt", "outcome", "status", "durationMs", "headersMs", "firstChunkMs", "firstTextMs",
  "bytesReceived", "chunkCount", "maxChunkGapMs", "lastReadWaitMs", "maxReadWaitMs", "firstByteLimitMs", "idleLimitMs", "totalLimitMs",
  "providerRequestId", "providerResponseId", "retryAfterMs", "responseContentType", "responseEncoding", "hasDone", "hasText", "hasReasoning", "finishReason", "protocolReason",
  "stage", "reason", "timeoutStage", "activeProviderAtStart", "activeProviderNow", "activeModelAtStart", "activeModelNow", "processInstanceId"]);
function safeObservation(event: string, fields: Record<string, unknown>): Observation {
  const result: Observation = { event };
  const flat = { ...fields, ...(fields.timings && typeof fields.timings === "object" ? fields.timings : {}) };
  for (const [key, value] of Object.entries(flat)) {
    if (!OBSERVATION_KEYS.has(key)) continue;
    if (value === null) result[key] = null;
    else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "string" && value.length <= 160) result[key] = value;
  }
  return result;
}
export async function directAdminProbe(body: object, key: string, fetcher: typeof fetch = fetch, totalMs = 120_000): Promise<Observation> {
  const start = Date.now(), elapsed = () => Date.now() - start, abort = new AbortController();
  const timer = setTimeout(() => abort.abort(Object.assign(new Error("Diagnostic deadline"), { name: "TimeoutError" })), totalMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let readStarted = 0, lastChunkAt: number | null = null, firstTextMs: number | null = null;
  let status: number | null = null, headersMs: number | null = null, providerResponseId: string | null = null;
  let bytesReceived = 0, chunkCount = 0, maxChunkGapMs = 0, lastReadWaitMs = 0;
  let inputTokens: number | null = null, outputTokens: number | null = null;
  let headerFields: ReturnType<typeof safeTransportHeaders> | undefined, outcome = "failed", reason: string | null = null;
  let errorName: string | null = null, errorCode: string | null = null, causeCode: string | null = null;
  const parser = new ChatCompletionStreamParser(chunk => {
    if (extractChatStreamDelta(chunk).trim()) firstTextMs ??= elapsed();
    providerResponseId = safeProviderRequestId(chunk.id) ?? providerResponseId;
    const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (Number.isSafeInteger(usage?.prompt_tokens) && usage!.prompt_tokens! >= 0) inputTokens = usage!.prompt_tokens!;
    if (Number.isSafeInteger(usage?.completion_tokens) && usage!.completion_tokens! >= 0) outputTokens = usage!.completion_tokens!;
  });
  try {
    const response = await fetcher(DEEPINFRA_CHAT_URL, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: abort.signal });
    status = response.status; headersMs = elapsed(); headerFields = safeTransportHeaders(response.headers, "deepinfra");
    if (!response.ok || !response.body) { reason = response.ok ? "missing_body" : "http_error"; await response.body?.cancel(); }
    else {
      reader = response.body.getReader(); const decoder = new TextDecoder();
      while (true) {
        readStarted = elapsed(); const { done, value } = await reader.read(); lastReadWaitMs = elapsed() - readStarted;
        if (done) break;
        const now = elapsed(); maxChunkGapMs = Math.max(maxChunkGapMs, lastChunkAt === null ? 0 : now - lastChunkAt); lastChunkAt = now;
        bytesReceived += value.byteLength; chunkCount++; parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode()); outcome = parser.end();
    }
  } catch (error) {
    const safe = toSafeDiagnostic(error);
    errorName = typeof safe.name === "string" ? safe.name : null;
    errorCode = typeof safe.code === "string" ? safe.code : null;
    try {
      const cause = toSafeDiagnostic((error as { cause?: unknown } | null)?.cause);
      causeCode = typeof cause.code === "string" ? cause.code : null;
    } catch { /* Hostile exceptions must not interrupt safe diagnostics. */ }
    lastReadWaitMs = reader ? elapsed() - readStarted : 0;
    reason = abort.signal.aborted ? "total_timeout" : "transport_error";
  } finally { clearTimeout(timer); if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
  parser.end();
  return { outcome, status, headersMs, firstTextMs, durationMs: elapsed(), bytesReceived, chunkCount, maxChunkGapMs, lastReadWaitMs,
    ...headerFields, providerResponseId, ...parser.diagnostics(), inputTokens, outputTokens, reason, errorName, errorCode, causeCode };
}

export async function executeAdminDiagnostic(job: AdminDiagnosticJob) {
  if (job !== current || job.state !== "running" || job.direct || job.pipeline) return;
  const messages: ChatCompletionMessage[] = [
    { role: "system", content: "Ты — хранитель лесного приюта. Отвечай по-русски. " + "Приют стоит в лесу; сюда приходят странники. ".repeat(80) },
    { role: "user", content: "Можно переночевать в приюте? Расскажи о нём и предложи, что делать дальше." },
  ];
  try {
    const model = deepinfraModel(job.model)!;
    const key = providerApiKey("deepinfra");
    job.direct = await directAdminProbe({ model: model.apiModel, messages, ...chatModelGenerationOptions(job.model), stream: true, stream_options: { include_usage: true } }, key,
      job.directClient === "undici" ? (url, init) => directDeepinfraFetch(String(url), init ?? {}) : fetch);
    job.phase = "pipeline";
    const attempts = new Map<string, Observation>(), observations: Observation[] = [], started = Date.now();
    let outcome = "failed", failure: Record<string, unknown> | null = null;
    await withChatTransportObserver((event, fields) => {
      if (event !== "chunk received" && observations.length < 12) observations.push(safeObservation(event, fields));
    }, () => withInMemoryAiCostContext(fields => {
      const id = fields.id as string;
      attempts.set(id, { ...attempts.get(id), ...safeObservation("cost attempt", { ...fields, costEventId: id }),
        inputTokens: typeof fields.inputTokens === "number" ? fields.inputTokens : null,
        outputTokens: typeof fields.outputTokens === "number" ? fields.outputTokens : null });
    }, async () => {
      try {
        const stream = await streamChatCompletion(job.model, messages, key);
        await consumeOpenAIChatCompletion(stream, () => {});
        outcome = "completed";
      } catch (error) { failure = toSafeDiagnostic(error); }
    }));
    job.pipeline = { outcome, durationMs: Date.now() - started, failure, attempts: [...attempts.values()], observations };
    job.observation = job.direct.outcome === "completed" && outcome === "completed" ? "failure_not_reproduced"
      : job.direct.outcome === "failed" && outcome === "failed" ? "investigate_provider_and_server_connection"
        : job.direct.outcome === "completed" ? "investigate_app_limits_and_processing" : "variable_provider_or_connection";
    job.state = "finished";
  } catch { job.state = "failed"; job.observation = "diagnostic_unavailable"; }
  finally { job.phase = "done"; job.finishedAt = Date.now(); }
}
export function adminDiagnosticPlan(model: string) {
  return { model, pipelineLimits: chatModelStreamTimeouts(model), directTotalMs: 120_000, independentRequests: true,
    causalProof: false, database: "in_memory", httpRouteTested: false };
}
