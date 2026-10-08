// Server-only. Store numbers and allowlisted labels, never prompts, keys or response bodies.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID } from "node:crypto";
import axios from "axios";
import type { AxiosRequestConfig, AxiosResponse } from "axios";
import { prisma } from "@/lib/prisma";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { finiteNonnegative, readCostUsage, resolveKodikCost, tokenCostRub, type CostUsage, type KodikApiSurface } from "./aiCostMath";
import { canonicalKodikModel, getKodikCostRates } from "./kodikCostRates";
import { getAccountingUsdRub } from "./currencyRates";

type CostContext = { operationId: string; actorHash: string | null; subscriptionType: string | null; sequence: number; audience: string };
const contexts = new AsyncLocalStorage<CostContext>();
export function withAiCostContext<T>(fn: () => T): T {
  return contexts.run({ operationId: randomUUID(), actorHash: null, subscriptionType: null, sequence: 0, audience: "system" }, fn);
}
export function setAiCostActor(actorId: string, subscriptionType?: string | null) {
  const ctx = contexts.getStore();
  if (!ctx) return;
  const key = process.env.NEXTAUTH_SECRET;
  ctx.actorHash = key ? createHmac("sha256", key).update(actorId).digest("hex") : null;
  ctx.audience = actorId.startsWith("guest:") ? "guest" : "user";
  ctx.subscriptionType = ["start", "dialog", "story", "history", "universe"].includes(subscriptionType ?? "") ? subscriptionType! : null;
}

type Ticket = { id: string; started: number; requestedModel: string; inputRate: number | null; outputRate: number | null; surface: KodikApiSurface | null };
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
  const surface = provider === "kodikrouter" ? purpose === "embedding" ? "embeddings" : "chat_completions" : null;
  const ticket: Ticket = { id: randomUUID(), started: Date.now(), requestedModel: model, inputRate: null, outputRate: null, surface };
  try {
    let quotedVC: number | null = null;
    if (provider === "kodikrouter") {
      const catalog = await prisma.model.findUnique({ where: { name: canonicalKodikModel(model) }, select: { pricePer1MInput: true, pricePer1MOutput: true, priceVC: true } });
      quotedVC = catalog?.priceVC ?? null;
      const rates = getKodikCostRates(model, catalog);
      ticket.inputRate = rates.input;
      ticket.outputRate = rates.output;
    }
    await prisma.aiCostEvent.create({ data: {
      id: ticket.id, operationId: ctx?.operationId ?? randomUUID(), actorHash: ctx?.actorHash,
      subscriptionType: ctx?.subscriptionType, attempt: ctx ? ++ctx.sequence : 1,
      provider, model, purpose, outcome: "pending", costSource: "unknown",
      apiSurface: surface ?? "other", accountingVersion: 2,
      quotedVC, audience: ctx?.audience ?? "system",
      inputRubPerMillion: ticket.inputRate, outputRubPerMillion: ticket.outputRate,
      estimatedCostRub: imageRub ?? null,
    } });
  } catch (error) { errorLog("AiCost", "Unable to persist cost attempt", toSafeDiagnostic(error)); }
  return ticket;
}
async function finish(ticket: Ticket, outcome: string, usage: CostUsage, status?: number, estimatedInput?: number, estimatedOutput?: number, actualModel?: string, providerRequestId?: unknown, providerResponseId?: unknown) {
  const measured = usage.inputTokens !== null && usage.outputTokens !== null;
  const input = usage.inputTokens ?? estimatedInput ?? null;
  const output = usage.outputTokens ?? estimatedOutput ?? null;
  try {
    if (actualModel && actualModel !== ticket.requestedModel) {
      const catalog = await prisma.model.findUnique({ where: { name: canonicalKodikModel(actualModel) }, select: { pricePer1MInput: true, pricePer1MOutput: true } });
      const rates = getKodikCostRates(actualModel, catalog);
      ticket.inputRate = rates.input;
      ticket.outputRate = rates.output;
    }
    // Cached reads are included in prompt_tokens. Full input pricing ignores
    // their discount and is an estimate. Cache writes can cost MORE than input;
    // without a verified write rate, do not invent a catalog estimate for them.
    const catalog = (usage.cacheWriteInputTokens ?? 0) > 0 ? null : tokenCostRub(input, output, ticket.inputRate, ticket.outputRate);
    const explicitFx = finiteNonnegative(Number(process.env['AI_COST_USD_RUB']));
    const needsFx = ticket.surface === "chat_completions" && (usage.reportedCost ?? 0) > 0;
    const fx = needsFx ? explicitFx && explicitFx > 0 ? explicitFx : await getAccountingUsdRub() : null;
    const cost = ticket.surface ? resolveKodikCost(ticket.surface, usage, catalog, fx) : {
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
  } catch (error) { errorLog("AiCost", "Unable to complete cost attempt", toSafeDiagnostic(error)); }
}
const noUsage = () => readCostUsage(null);

export async function meteredPost<T = AxiosResponse["data"]>(purpose: string, url: string, body: unknown,
  config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
  const payload = body as { model?: unknown };
  const ticket = await begin(safeModel(payload?.model), purpose);
  try {
    const response = await axios.post<T>(url, body, config);
    const actualModel = (response.data as { model?: unknown })?.model;
    await finish(ticket, response.status >= 400 ? "failed" : "completed", readCostUsage(response.data, purpose === "embedding"), response.status,
      undefined, undefined, typeof actualModel === "string" ? safeModel(actualModel) : undefined,
      response.headers["x-kodikrouter-request-id"], (response.data as { id?: unknown })?.id);
    return response;
  } catch (error) {
    const response = axios.isAxiosError(error) ? error.response : null;
    await finish(ticket, "failed", readCostUsage(response?.data, purpose === "embedding"), response?.status,
      undefined, undefined, undefined, response?.headers?.["x-kodikrouter-request-id"], response?.data?.id);
    throw error;
  }
}

const streams = new WeakMap<ReadableStream<Uint8Array>, Ticket>();
export async function meteredChatFetch(url: string, init: RequestInit, model: string, estimatedInput: number): Promise<Response> {
  const ticket = await begin(safeModel(model), "chat");
  let response: Response;
  try { response = await fetch(url, init); }
  catch (error) { await finish(ticket, "failed", noUsage()); throw error; }
  if (!response.ok || !response.body) {
    await finish(ticket, "failed", noUsage(), response.status, undefined, undefined, undefined,
      response.headers.get("x-kodikrouter-request-id"));
    return response;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", usage = noUsage(), outputChars = 0, ended = false, actualModel: string | undefined, responseId: string | null = null;
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    try {
      const chunk = JSON.parse(line.slice(5).trim());
      responseId = requestId(chunk.id) ?? responseId;
      if (typeof chunk.model === "string") actualModel = safeModel(chunk.model);
      const next = readCostUsage(chunk);
      // Providers may emit tokens and cost in different final frames. These are
      // cumulative snapshots, not increments; do not sum duplicate usage chunks.
      usage = {
        inputTokens: next.inputTokens ?? usage.inputTokens,
        outputTokens: next.outputTokens ?? usage.outputTokens,
        cachedInputTokens: next.cachedInputTokens ?? usage.cachedInputTokens,
        cacheWriteInputTokens: next.cacheWriteInputTokens ?? usage.cacheWriteInputTokens,
        reportedCost: next.reportedCost ?? usage.reportedCost,
      };
      const text = chunk?.choices?.[0]?.delta?.content;
      if (typeof text === "string") outputChars += text.length;
    } catch { /* [DONE], heartbeat, malformed frame: never store raw content */ }
  };
  const complete = async (outcome: string) => {
    if (ended) return;
    ended = true;
    if (buffer.trim()) consume(buffer);
    await finish(ticket, outcome, usage, response.status, estimatedInput,
      outcome === "completed" ? Math.ceil(outputChars / 4) : undefined, actualModel, response.headers.get("x-kodikrouter-request-id"), responseId);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { buffer += decoder.decode(); await complete("completed"); controller.close(); reader.releaseLock(); return; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
        // Bound parser memory; forwarding is unaffected.
        if (buffer.length > 1_000_000) buffer = "";
        for (const line of lines) consume(line);
        controller.enqueue(value);
      } catch (error) { await complete("failed"); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { await complete("cancelled"); } },
  });
  streams.set(body, ticket);
  return new Response(body, { status: response.status, headers: response.headers });
}
export async function recordChatCostCharge(stream: ReadableStream<Uint8Array>, chargedVC: number) {
  const ticket = streams.get(stream);
  if (!ticket) return;
  try { await prisma.aiCostEvent.update({ where: { id: ticket.id }, data: { chargedVC } }); }
  catch (error) { errorLog("AiCost", "Unable to record VC charge", toSafeDiagnostic(error)); }
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
