// Server-only. Store numbers and allowlisted labels, never prompts, keys or response bodies.
import { AsyncLocalStorage } from "node:async_hooks";
import { deepinfraFetch, deepinfraAxiosOptions } from "./deepinfraNetwork";
import { createHmac, randomUUID } from "node:crypto";
import axios from "axios";
import type { AxiosRequestConfig, AxiosResponse } from "axios";
import { prisma } from "@/lib/prisma";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { logChatTransportFailure } from "./chatDiagnostics";
import { beginAiTransport, createChatReadMetrics, safeTransportHeaders, traceChatTransport } from "./aiTransportDiagnostics";
import { finiteNonnegative, readCostUsage, readDeepinfraCostUsage, resolveDeepinfraCost, resolveKodikCost, tokenCostRub, type CostUsage, type KodikApiSurface } from "./aiCostMath";
import { deepinfraModel } from "./deepinfraModels";
import { DEEPINFRA_EMBEDDING_MODEL, DEEPINFRA_EMBEDDING_INPUT_USD_PER_MILLION } from "./embeddingProviders";
import { deepinfraUsdRub, textProviderForUrl } from "./aiProviders";
import { canonicalKodikModel, getKodikCostRates } from "./kodikCostRates";
import { getAccountingUsdRub } from "./currencyRates";
import { ChatCompletionStreamParser, extractChatStreamDelta } from "./chatCompletionStream";
import type { AvatarGeneration } from "@prisma/client";

type CostContext = { operationId: string; actorHash: string | null; threadHash: string | null; subscriptionType: string | null; sequence: number; audience: string };
const contexts = new AsyncLocalStorage<CostContext>();
// Request-scoped diagnostic accounting; never changes the store used by concurrent users.
const diagnosticAttempts = new AsyncLocalStorage<(fields: Record<string, unknown>) => void>();
export function withInMemoryAiCostContext<T>(onAttempt: (fields: Record<string, unknown>) => void, fn: () => T): T {
  return diagnosticAttempts.run(onAttempt, () => withAiCostContext(fn));
}
export function withAiCostContext<T>(fn: () => T): T {
  return contexts.run({ operationId: randomUUID(), actorHash: null, threadHash: null, subscriptionType: null, sequence: 0, audience: "system" }, fn);
}
/** Correlation only: do not expose actor hashes or any customer content to logs. */
export function aiCostDiagnosticContext() {
  const ctx = contexts.getStore();
  return { operationId: ctx?.operationId, audience: ctx?.audience ?? "system" };
}
export function setAiCostActor(actorId: string, subscriptionType?: string | null) {
  const ctx = contexts.getStore();
  if (!ctx) return;
  const key = process.env.NEXTAUTH_SECRET;
  ctx.actorHash = key ? createHmac("sha256", key).update(actorId).digest("hex") : null;
  ctx.audience = actorId.startsWith("guest:") ? "guest" : "user";
  ctx.subscriptionType = ["start", "dialog", "story", "history", "universe"].includes(subscriptionType ?? "") ? subscriptionType! : null;
}
/** Story of the operation; background memory work of the same request inherits it. Only an HMAC is stored. */
export function setAiCostThread(threadId: string | null) {
  const ctx = contexts.getStore();
  if (!ctx) return;
  const key = process.env.NEXTAUTH_SECRET;
  ctx.threadHash = key && threadId ? createHmac("sha256", key).update(`thread:${threadId}`).digest("hex") : null;
}

type Ticket = { id: string; operationId: string; attempt: number; audience: string; started: number; requestedModel: string; inputRate: number | null; outputRate: number | null; surface: KodikApiSurface | null; provider: string; fx: number | null };
function ticketDiagnosticContext(ticket: Ticket) {
  return { operationId: ticket.operationId, costEventId: ticket.id, attempt: ticket.attempt,
    audience: ticket.audience, provider: ticket.provider, model: ticket.requestedModel };
}
function safeModel(model: unknown): string {
  return typeof model === "string" && /^[a-zA-Z0-9._:/-]{1,160}$/.test(model)
    && !/^(https?:|postgres|sk[-_]|crya_|re_|bearer)/i.test(model) ? model : "unknown";
}
function requestId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    && !/^(sk[-_]|crya_|re_|bearer)/i.test(value) ? value : null;
}
async function begin(model: string, purpose: string, provider = "kodikrouter", imageRub?: number): Promise<Ticket> {
  const ctx = contexts.getStore();
  const surface = provider === "kodikrouter" || provider === "deepinfra" ? purpose === "embedding" ? "embeddings" : "chat_completions" : null;
  const ticket: Ticket = { id: randomUUID(), operationId: ctx?.operationId ?? randomUUID(), attempt: ctx ? ++ctx.sequence : 1,
    audience: ctx?.audience ?? "system", started: Date.now(), requestedModel: model, inputRate: null, outputRate: null, surface, provider, fx: provider === "deepinfra" ? deepinfraUsdRub() : null };
  const diagnostic = diagnosticAttempts.getStore();
  if (diagnostic) {
    if (provider !== "deepinfra" || purpose !== "chat") throw Object.assign(new Error("Diagnostic provider unavailable"), { __noRetry: true });
    diagnostic({ id: ticket.id, operationId: ticket.operationId, attempt: ticket.attempt, outcome: "pending" });
    return ticket;
  }
  try {
    let quotedVC: number | null = null;
    if (provider === "kodikrouter") {
      const catalog = await prisma.model.findUnique({ where: { name: canonicalKodikModel(model) }, select: { pricePer1MInput: true, pricePer1MOutput: true, priceVC: true } });
      quotedVC = catalog?.priceVC ?? null;
      const rates = getKodikCostRates(model, catalog);
      ticket.inputRate = rates.input;
      ticket.outputRate = rates.output;
    }
    if (provider === "deepinfra") {
      const quote = deepinfraModel(model);
      const catalog = quote ? await prisma.model.findUnique({ where: { name: quote.name }, select: { priceVC: true } }) : null;
      quotedVC = catalog?.priceVC ?? quote?.priceVC ?? null;
      ticket.inputRate = quote && ticket.fx ? quote.inputUsdPerMillion * ticket.fx : null;
      ticket.outputRate = quote && ticket.fx ? quote.outputUsdPerMillion * ticket.fx : null;
      if (surface === "embeddings" && model === DEEPINFRA_EMBEDDING_MODEL && ticket.fx) {
        ticket.inputRate = DEEPINFRA_EMBEDDING_INPUT_USD_PER_MILLION * ticket.fx;
        ticket.outputRate = 0;
      }
    }
    await prisma.aiCostEvent.create({ data: {
      id: ticket.id, operationId: ticket.operationId, actorHash: ctx?.actorHash, threadHash: ctx?.threadHash ?? null,
      subscriptionType: ctx?.subscriptionType, attempt: ticket.attempt,
      provider, model, purpose, outcome: "pending", costSource: "unknown",
      apiSurface: surface ?? "other", accountingVersion: 2,
      quotedVC, audience: ctx?.audience ?? "system",
      inputRubPerMillion: ticket.inputRate, outputRubPerMillion: ticket.outputRate,
      estimatedCostRub: imageRub ?? null,
    } });
  } catch (error) { errorLog("AiCost", "Unable to persist cost attempt", ticketDiagnosticContext(ticket), toSafeDiagnostic(error)); }
  return ticket;
}
async function finish(ticket: Ticket, outcome: string, usage: CostUsage, status?: number, estimatedInput?: number, estimatedOutput?: number, actualModel?: string, providerRequestId?: unknown, providerResponseId?: unknown) {
  const diagnostic = diagnosticAttempts.getStore();
  if (diagnostic) {
    diagnostic({ id: ticket.id, outcome, durationMs: Date.now() - ticket.started, status: status ?? null,
      providerRequestId: requestId(providerRequestId), providerResponseId: requestId(providerResponseId),
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    return;
  }
  const measured = usage.inputTokens !== null && usage.outputTokens !== null;
  const input = usage.inputTokens ?? estimatedInput ?? null;
  const output = usage.outputTokens ?? estimatedOutput ?? null;
  try {
    if (actualModel && actualModel !== ticket.requestedModel) {
      if (ticket.provider === "deepinfra") {
        const quote = deepinfraModel(actualModel);
        ticket.inputRate = quote && ticket.fx ? quote.inputUsdPerMillion * ticket.fx : null;
        ticket.outputRate = quote && ticket.fx ? quote.outputUsdPerMillion * ticket.fx : null;
      } else {
        const catalog = await prisma.model.findUnique({ where: { name: canonicalKodikModel(actualModel) }, select: { pricePer1MInput: true, pricePer1MOutput: true } });
        const rates = getKodikCostRates(actualModel, catalog);
        ticket.inputRate = rates.input;
        ticket.outputRate = rates.output;
      }
    }
    // Cached reads are included in prompt_tokens. Full input pricing ignores
    // their discount and is an estimate. Cache writes can cost MORE than input;
    // without a verified write rate, do not invent a catalog estimate for them.
    const catalog = (usage.cacheWriteInputTokens ?? 0) > 0 ? null : tokenCostRub(input, output, ticket.inputRate, ticket.outputRate);
    const explicitFx = finiteNonnegative(Number(process.env['AI_COST_USD_RUB']));
    const needsFx = ticket.provider === "kodikrouter" && ticket.surface === "chat_completions" && (usage.reportedCost ?? 0) > 0;
    const fx = needsFx ? explicitFx && explicitFx > 0 ? explicitFx : await getAccountingUsdRub() : null;
    const cost = ticket.provider === "deepinfra" ? resolveDeepinfraCost(usage, catalog, ticket.fx) : ticket.surface ? resolveKodikCost(ticket.surface, usage, catalog, fx) : {
      providerCostCurrency: null, providerCostSemantics: "unverified", usdRub: null,
      estimatedCostRub: null, costSource: "unknown",
    };
    if (cost.costSource === "chat_usd_estimate" && !(explicitFx && explicitFx > 0)) {
      cost.costSource = "chat_cbr_estimate";
    }
    await prisma.aiCostEvent.update({ where: { id: ticket.id }, data: {
      outcome, durationMs: Date.now() - ticket.started, httpStatus: status,
      inputTokens: input, outputTokens: output, cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      usageSource: measured ? "provider" : input !== null && output !== null ? "estimated" : "missing",
      // Only the read-only reconciliation report can establish a ledger debit.
      // Legacy reportedCostRub values are retained historically, not trusted.
      reportedCostRub: null, ...cost,
      actualModel: actualModel ?? null, providerCostNative: usage.reportedCost,
      providerRequestId: requestId(providerRequestId),
      providerResponseId: requestId(providerResponseId),
      inputRubPerMillion: ticket.inputRate, outputRubPerMillion: ticket.outputRate,
    } });
  } catch (error) { errorLog("AiCost", "Unable to complete cost attempt", ticketDiagnosticContext(ticket), toSafeDiagnostic(error)); }
}
const noUsage = () => readCostUsage(null);
function providerUsage(ticket: Ticket, data: unknown, embedding = false) {
  return ticket.provider === "deepinfra" ? readDeepinfraCostUsage(data, embedding) : readCostUsage(data, embedding);
}
function responseRequestId(ticket: Ticket, headers: Record<string, unknown>) {
  return ticket.provider === "deepinfra" ? headers["x-deepinfra-request-id"] ?? headers["x-request-id"] : headers["x-kodikrouter-request-id"];
}

// A provider that stops answering (KodikRouter ETIMEDOUT on 2026-10-11) otherwise holds a request
// until the OS gives up, about 130 s. Callers on the reply path pass a shorter timeout.
const SERVICE_REQUEST_TIMEOUT_MS = 30_000;

export async function meteredPost<T = AxiosResponse["data"]>(purpose: string, url: string, body: unknown,
  config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
  const payload = body as { model?: unknown };
  const ticket = await begin(safeModel(payload?.model), purpose, textProviderForUrl(url));
  const transport = beginAiTransport(ticket.provider, ticket.requestedModel, purpose);
  const started = Date.now();
  let networkRoute = "unavailable";
  try {
    const networkOptions = deepinfraAxiosOptions(url);
    networkRoute = networkOptions.httpsAgent ? "proxy" : "direct";
    const response = await axios.post<T>(url, body, { ...config, ...networkOptions, timeout: config?.timeout || SERVICE_REQUEST_TIMEOUT_MS, maxRedirects: 0 });
    transport.release();
    const actualModel = (response.data as { model?: unknown })?.model;
    await finish(ticket, response.status >= 400 ? "failed" : "completed", providerUsage(ticket, response.data, purpose === "embedding"), response.status,
      undefined, undefined, typeof actualModel === "string" ? safeModel(actualModel) : undefined,
      responseRequestId(ticket, response.headers), (response.data as { id?: unknown })?.id);
    if (purpose === "avatar_prompt") {
      infoLog("AvatarPrompt", "request completed", { ...ticketDiagnosticContext(ticket), purpose, networkRoute,
        status: response.status, durationMs: Date.now() - started });
    }
    return response;
  } catch (error) {
    const response = axios.isAxiosError(error) ? error.response : null;
    errorLog("ChatDiagnostics", "service attempt failed", { ...ticketDiagnosticContext(ticket), ...transport.fields(),
      ...safeTransportHeaders(response?.headers ?? {}, ticket.provider), stage: "service_request",
      networkRoute, status: response?.status, durationMs: Date.now() - started }, toSafeDiagnostic(error));
    transport.release();
    await finish(ticket, "failed", providerUsage(ticket, response?.data, purpose === "embedding"), response?.status,
      undefined, undefined, undefined, responseRequestId(ticket, response?.headers ?? {}), response?.data?.id);
    throw error;
  } finally {
    transport.release();
  }
}

const streams = new WeakMap<ReadableStream<Uint8Array>, { ticket: Ticket; completed: boolean }>();
/** onChunk fires for every body chunk, so callers can run an idle watchdog without replacing the tracked stream. */
export async function meteredChatFetch(url: string, init: RequestInit, model: string, estimatedInput: number,
  onEnd?: () => void, onChunk?: () => void,
  limits?: { firstByteMs: number; idleMs: number; totalMs: number }): Promise<Response> {
  const ticket = await begin(safeModel(model), "chat", textProviderForUrl(url));
  const requestIdHeader = ticket.provider === "deepinfra" ? "x-request-id" : "x-kodikrouter-request-id";
  // Provider timing starts after local cost bookkeeping, immediately before the request.
  const started = Date.now();
  const transport = beginAiTransport(ticket.provider, ticket.requestedModel, "chat");
  const context = { ...ticketDiagnosticContext(ticket), firstByteLimitMs: limits?.firstByteMs,
    idleLimitMs: limits?.idleMs, totalLimitMs: limits?.totalMs };
  const metrics = createChatReadMetrics(started);
  traceChatTransport("attempt started", { ...context, ...transport.fields() });
  let response: Response;
  try { response = await deepinfraFetch(url, { ...init, redirect: "error" }); }
  catch (error) {
    logChatTransportFailure({ ...context, ...transport.fields(), stage: "awaiting_headers", durationMs: Date.now() - started }, error, init.signal);
    transport.release();
    onEnd?.(); await finish(ticket, "failed", noUsage()); throw error;
  }
  const headersMs = Date.now() - started;
  const headerFields = safeTransportHeaders(response.headers, ticket.provider);
  traceChatTransport("headers received", { ...context, ...transport.fields(), ...headerFields, status: response.status, headersMs });
  if (!response.ok || !response.body) {
    errorLog("ChatDiagnostics", "attempt failed", { ...context, ...transport.fields(), ...headerFields, stage: "headers", status: response.status,
      durationMs: Date.now() - started, headersMs, reason: !response.ok ? "http_error" : "missing_body" });
    transport.release();
    await finish(ticket, "failed", noUsage(), response.status, undefined, undefined, undefined,
      headerFields.providerRequestId);
    onEnd?.();
    return response;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let usage = noUsage(), outputChars = 0, ended = false, cancelled = false, actualModel: string | undefined, responseId: string | null = null;
  let bytesReceived = 0, firstChunkMs: number | null = null, firstTextMs: number | null = null, lastChunkAt: number | null = null;
  const tracked = { ticket, completed: false };
  const parser = new ChatCompletionStreamParser((chunk) => {
    responseId = requestId(chunk.id) ?? responseId;
    if (typeof chunk.model === "string") actualModel = safeModel(chunk.model);
    const next = providerUsage(ticket, chunk);
    // Providers may emit tokens and cost in different final frames. These are
    // cumulative snapshots, not increments; do not sum duplicate usage chunks.
    usage = {
      inputTokens: next.inputTokens ?? usage.inputTokens,
      outputTokens: next.outputTokens ?? usage.outputTokens,
      cachedInputTokens: next.cachedInputTokens ?? usage.cachedInputTokens,
      cacheWriteInputTokens: next.cacheWriteInputTokens ?? usage.cacheWriteInputTokens,
      reportedCost: next.reportedCost ?? usage.reportedCost,
    };
    const delta = extractChatStreamDelta(chunk);
    if (delta.trim() && firstTextMs === null) firstTextMs = Date.now() - started;
    outputChars += delta.length;
  });
  const complete = async (outcome: string, error?: unknown) => {
    if (ended) return;
    ended = true;
    onEnd?.();
    const protocolOutcome = parser.end();
    if (outcome === "completed") outcome = protocolOutcome;
    tracked.completed = outcome === "completed";
    if (!tracked.completed) {
      const diagnostic = { ...context, ...transport.fields(), ...headerFields, ...metrics.fields(), providerResponseId: responseId,
        stage: firstTextMs === null ? "awaiting_text" : "streaming",
        outcome, status: response.status, durationMs: Date.now() - started, headersMs, firstChunkMs,
        firstTextMs, bytesReceived, idleMs: Date.now() - (lastChunkAt ?? started + headersMs), ...parser.diagnostics() };
      if (error !== undefined || init.signal?.aborted) {
        logChatTransportFailure(diagnostic, error, init.signal);
      } else {
        errorLog("ChatDiagnostics", "attempt failed", { ...diagnostic,
          reason: outcome === "cancelled" ? "consumer_cancelled" : "invalid_stream" });
      }
    }
    traceChatTransport("attempt ended", { ...context, ...transport.fields(), ...headerFields, ...metrics.fields(),
      providerResponseId: responseId, outcome, status: response.status,
      timings: { headersMs, firstChunkMs, firstTextMs, bytesReceived,
        idleMs: Date.now() - (lastChunkAt ?? started + headersMs), durationMs: Date.now() - started }, ...parser.diagnostics() });
    transport.release();
    await finish(ticket, outcome, usage, response.status, estimatedInput,
      outcome === "completed" ? Math.ceil(outputChars / 4) : undefined, actualModel, response.headers.get("x-deepinfra-request-id") ?? response.headers.get(requestIdHeader), responseId);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        metrics.startRead();
        const { done, value } = await reader.read();
        metrics.endRead();
        if (cancelled) return;
        if (done) { parser.push(decoder.decode()); await complete("completed"); controller.close(); reader.releaseLock(); return; }
        bytesReceived += value.byteLength;
        lastChunkAt = Date.now();
        firstChunkMs ??= lastChunkAt - started;
        const chunkFields = metrics.chunk(value.byteLength);
        // Bound per-attempt trace volume, but keep summary counters for the entire stream.
        if (chunkFields.chunkIndex <= 20) traceChatTransport("chunk received", { ...context, ...chunkFields });
        onChunk?.();
        parser.push(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      } catch (error) { metrics.endRead(); await complete("failed", error); controller.error(error); reader.releaseLock(); }
    },
    async cancel(reason) { cancelled = true; try { await reader.cancel(reason); } finally { await complete("cancelled"); reader.releaseLock(); } },
  });
  streams.set(body, tracked);
  return new Response(body, { status: response.status, headers: response.headers });
}
export async function recordChatCostCharge(stream: ReadableStream<Uint8Array>, chargedVC: number) {
  const tracked = streams.get(stream);
  if (!tracked?.completed) return;
  const { ticket } = tracked;
  try { await prisma.aiCostEvent.update({ where: { id: ticket.id }, data: { chargedVC } }); }
  catch (error) { errorLog("AiCost", "Unable to record VC charge", ticketDiagnosticContext(ticket), toSafeDiagnostic(error)); }
}

export async function meteredTranslationFetch(url: string, init: RequestInit, characters: number): Promise<Response> {
  const ticket = await begin("translate-v2", "translation", "yandextranslate");
  const rate = finiteNonnegative(Number(process.env['YANDEX_TRANSLATE_COST_RUB_PER_MILLION_CHARS']));
  let status: number | undefined;
  try {
    const response = await fetch(url, init); status = response.status;
    await prisma.aiCostEvent.update({ where: { id: ticket.id }, data: {
      outcome: response.ok ? "completed" : "failed", httpStatus: status,
      durationMs: Date.now() - ticket.started, inputCharacters: characters,
      usageSource: "local_character_count", characterRubPerMillion: rate,
      costSource: response.ok && rate !== null && rate > 0 ? "configured_estimate" : "unknown",
      estimatedCostRub: response.ok && rate !== null && rate > 0 ? characters * rate / 1_000_000 : null,
    } }).catch(error => errorLog("AiCost", "Unable to record translation cost", toSafeDiagnostic(error)));
    return response;
  } catch (error) { await finish(ticket, "failed", noUsage(), status); throw error; }
}

export async function meteredLegacySubmission(url: string, init: RequestInit, model: string): Promise<Response> {
  const ticket = await begin(safeModel(model), "legacy_generation", "muapi");
  try {
    const response = await fetch(url, init);
    await prisma.aiCostEvent.update({ where: { id: ticket.id }, data: {
      outcome: response.ok ? "submitted" : "failed", httpStatus: response.status,
      durationMs: Date.now() - ticket.started,
      // Async acceptance and product credits do not establish the provider's bill.
      costSource: "unknown",
    } }).catch(error => errorLog("AiCost", "Unable to record async submission", toSafeDiagnostic(error)));
    return response;
  } catch (error) { await finish(ticket, "failed", noUsage()); throw error; }
}

export async function withAvatarCost<T>(model: string, estimatedCostRub: number,
  fn: (onRun: (runId: string) => Promise<void>) => Promise<T>, quotaReservationId?: string): Promise<T> {
  const ticket = await begin(safeModel(model), "avatar", "createya", estimatedCostRub);
  const onRun = async (runId: string) => {
    try { await prisma.aiCostEvent.update({ where: { id: ticket.id }, data: { providerRequestId: requestId(runId), quotaReservationId } }); }
    catch (error) { errorLog("AiCost", "Unable to record provider reference", toSafeDiagnostic(error)); }
  };
  try {
    const result = await fn(onRun);
    await prisma.aiCostEvent.update({ where: { id: ticket.id }, data: {
      outcome: "completed", durationMs: Date.now() - ticket.started,
      usageSource: "configured", costSource: "configured_estimate", estimatedCostRub,
      quotaReservationId,
    } }).catch(error => errorLog("AiCost", "Unable to record avatar cost", toSafeDiagnostic(error)));
    return result;
  } catch (error) {
    await prisma.aiCostEvent.update({ where: { id: ticket.id }, data: {
      outcome: "failed", durationMs: Date.now() - ticket.started,
      // Failed/timed-out provider runs can still be billed; keep unknown, not zero.
      costSource: "unknown", estimatedCostRub: null,
      quotaReservationId,
    } }).catch(err => errorLog("AiCost", "Unable to record avatar failure", toSafeDiagnostic(err)));
    throw error;
  }
}

/** One durable event per paid image job. Credits are measured; RUB is an acquisition estimate. */
export async function recordKieAvatarCost(job: AvatarGeneration) {
  const ctx = contexts.getStore();
  const credits = job.credits;
  const data = {
    provider: "kie", model: job.model, purpose: "avatar", apiSurface: "image_generation",
    accountingVersion: 2, providerRequestId: job.providerTaskId, quotaReservationId: job.reservationId,
    outcome: job.state === "succeeded" ? "completed" : job.state === "failed" ? "failed" : "pending",
    durationMs: ["succeeded", "failed"].includes(job.state) ? job.updatedAt.getTime() - job.createdAt.getTime() : null,
    usageSource: credits === null ? "configured" : "provider",
    providerCostNative: credits, providerCostCurrency: credits === null ? null : "CREDIT",
    providerCostSemantics: credits === null ? "unverified" : "reported_credits_consumed",
    // Keep estimated conversion separate from confirmed RUB ledger debits.
    reportedCostRub: null,
    costSource: credits !== null ? "kie_credits_estimate" : job.state === "succeeded" ? "configured_estimate" : "unknown",
    estimatedCostRub: credits !== null ? credits * job.creditRub : job.state === "succeeded" ? job.estimatedCredits * job.creditRub : null,
  };
  try {
    await prisma.aiCostEvent.upsert({ where: { id: job.id }, update: {}, create: {
      id: job.id, operationId: job.id, attempt: 1, audience: "user", ...data,
      actorHash: ctx?.actorHash ?? (process.env.NEXTAUTH_SECRET ? createHmac("sha256", process.env.NEXTAUTH_SECRET).update(job.userId).digest("hex") : null),
      subscriptionType: ctx?.subscriptionType,
    } });
    // A stale creation/poll writer cannot overwrite a completed event from another worker.
    await prisma.aiCostEvent.updateMany({ where: { id: job.id, outcome: { in: data.outcome === "pending" ? ["pending"] : ["pending", data.outcome] } }, data });
  } catch (error) { errorLog("AiCost", "Unable to record Kie avatar cost", toSafeDiagnostic(error)); }
}
