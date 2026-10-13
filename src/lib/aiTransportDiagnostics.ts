// Transport observations only: never retain payloads, credentials or arbitrary headers.
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { infoLog } from "./logger";

const processInstanceId = randomUUID();
const activeProviders = new Map<string, number>();
const activeModels = new Map<string, number>();
const observers = new AsyncLocalStorage<(event: string, fields: Record<string, unknown>) => void>();
export function withChatTransportObserver<T>(observer: (event: string, fields: Record<string, unknown>) => void, fn: () => T): T {
  return observers.run(observer, fn);
}
export function observeChatTransport(event: string, fields: Record<string, unknown>) {
  observers.getStore()?.(event, fields);
}
export function chatTransportTraceEnabled() { return process.env['CHAT_TRANSPORT_TRACE'] === "1"; }

export function safeProviderRequestId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    && !/^(sk[-_]|crya_|re_|bearer)/i.test(value) ? value : null;
}

export function safeTransportHeaders(headers: Headers | Record<string, unknown>, provider: string) {
  // Undici's Web Headers are a separate class from Node's global Headers.
  const get = (name: string) => typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
  const rawRetry = get("retry-after");
  let retryAfterMs: number | null = null;
  if (typeof rawRetry === "string" || typeof rawRetry === "number") {
    const raw = String(rawRetry).trim();
    const ms = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
    if (Number.isFinite(ms) && ms >= 0 && ms <= 86_400_000) retryAfterMs = Math.ceil(ms);
  }
  const contentType = String(get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const encoding = String(get("content-encoding") ?? "").toLowerCase();
  return {
    providerRequestId: safeProviderRequestId(provider === "deepinfra"
      ? get("x-deepinfra-request-id") ?? get("x-request-id") : get("x-kodikrouter-request-id")),
    retryAfterMs,
    responseContentType: ["text/event-stream", "application/json"].includes(contentType) ? contentType : contentType ? "other" : "absent",
    responseEncoding: ["gzip", "br", "deflate", "identity"].includes(encoding) ? encoding : encoding ? "other" : "absent",
  };
}

/** Process-local observations, including chat and service calls sharing the provider/model. */
export function beginAiTransport(provider: string, model: string, purpose: string) {
  const modelKey = `${provider}:${model}`;
  const activeProviderAtStart = (activeProviders.get(provider) ?? 0) + 1;
  const activeModelAtStart = (activeModels.get(modelKey) ?? 0) + 1;
  activeProviders.set(provider, activeProviderAtStart);
  activeModels.set(modelKey, activeModelAtStart);
  let released = false;
  return {
    fields: () => ({ processInstanceId, purpose, activeProviderAtStart, activeModelAtStart,
      activeProviderNow: activeProviders.get(provider) ?? 0, activeModelNow: activeModels.get(modelKey) ?? 0 }),
    release() {
      if (released) return;
      released = true;
      for (const [map, key] of [[activeProviders, provider], [activeModels, modelKey]] as const) {
        const next = (map.get(key) ?? 1) - 1;
        if (next <= 0) map.delete(key); else map.set(key, next);
      }
    },
  };
}

export function traceChatTransport(event: string, fields: Record<string, unknown>) {
  observeChatTransport(event, fields);
  if (chatTransportTraceEnabled()) infoLog("ChatTransport", event, fields);
}

/** Differentiates a pending upstream read from time between consumer pulls. */
export function createChatReadMetrics(started: number) {
  let chunkCount = 0, lastChunkAt: number | null = null, lastChunkBytes = 0, maxChunkGapMs = 0;
  let readStarted: number | null = null, lastReadWaitMs = 0, maxReadWaitMs = 0;
  return {
    startRead() { readStarted = Date.now(); },
    endRead() {
      if (readStarted !== null) lastReadWaitMs = Date.now() - readStarted;
      maxReadWaitMs = Math.max(maxReadWaitMs, lastReadWaitMs);
      readStarted = null;
    },
    chunk(bytes: number) {
      const now = Date.now();
      const chunkGapMs = lastChunkAt === null ? null : now - lastChunkAt;
      maxChunkGapMs = Math.max(maxChunkGapMs, chunkGapMs ?? 0);
      lastChunkAt = now; lastChunkBytes = bytes; chunkCount++;
      return { chunkIndex: chunkCount, chunkBytes: bytes, chunkGapMs, elapsedMs: now - started };
    },
    fields() { return { chunkCount, lastChunkBytes, lastChunkMs: lastChunkAt === null ? null : lastChunkAt - started,
      maxChunkGapMs, lastReadWaitMs, maxReadWaitMs, readPending: readStarted !== null,
      readPendingMs: readStarted === null ? 0 : Date.now() - readStarted }; },
  };
}
