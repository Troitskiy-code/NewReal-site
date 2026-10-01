import { Logtail } from "@logtail/node";
import {
  isPlainObject,
  redactSensitive,
  redactText,
  safeErrorFields,
  UNAVAILABLE,
  type SafeLogValue,
} from "./redactSensitive";

export type DiagnosticSink = {
  debug: (message: string, context?: Record<string, unknown>) => unknown;
  info: (message: string, context?: Record<string, unknown>) => unknown;
  error: (message: string, context?: Record<string, unknown>) => unknown;
  flush?: () => unknown;
};

const ERROR_LOG_CONTEXT_KEYS = new Set([
  "userId",
  "status",
  "invId",
  "recurringId",
  "reason",
  "configured",
  "provided",
  "matched",
  "domain",
  "found",
  "hasPassword",
  "checked",
  "renewed",
  "failed",
  "skipped",
  "expiredCoins",
  "category",
  "name",
  "code",
  "planId",
  "period",
  "prefix",
  "truncated",
  "ok",
  "count",
  "ticketId",
  "locale",
  "scope",
  "id",
  "expiresAt",
]);

const ERROR_PAYLOAD_KEYS = new Set([
  "message",
  "stack",
  "error",
  "cause",
  "meta",
  "config",
  "headers",
  "data",
  "error_description",
  "error_uri",
]);

export function toSafeDiagnostic(error: unknown): Record<string, SafeLogValue> {
  return safeErrorFields(error);
}

function createLogtail(): DiagnosticSink | null {
  const token = process.env.LOGTAIL_SOURCE_TOKEN?.trim();
  const endpoint = process.env.LOGTAIL_INGESTING_HOST?.trim();
  if (!token || !endpoint) return null;
  return new Logtail(token, { endpoint });
}

let diagnosticSink: DiagnosticSink | null = createLogtail();

export function setDiagnosticSink(sink: DiagnosticSink | null) {
  diagnosticSink = sink;
}

function serializeSafe(value: SafeLogValue): string {
  try {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      return String(value);
    }
    return JSON.stringify(value);
  } catch {
    return UNAVAILABLE;
  }
}

function hasErrorPayloadKey(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => ERROR_PAYLOAD_KEYS.has(key) || ERROR_PAYLOAD_KEYS.has(key.toLowerCase()));
}

const ERROR_LOG_MAX_DEPTH = 6;
const ERROR_LOG_MAX_ARRAY = 32;
const ERROR_LOG_MAX_VISITS = 64;

function formatErrorLogArg(
  arg: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
  budget = { visits: 0 }
): SafeLogValue {
  try {
    if (depth > ERROR_LOG_MAX_DEPTH || budget.visits >= ERROR_LOG_MAX_VISITS) {
      return { category: "truncated" };
    }
    if (arg === null) return null;
    if (typeof arg === "number") return Number.isFinite(arg) ? arg : null;
    if (typeof arg === "boolean") return arg;
    if (typeof arg !== "object") return safeErrorFields(arg);
    if (arg instanceof Error) return safeErrorFields(arg);
    if (seen.has(arg)) return "[circular]";
    seen.add(arg);
    budget.visits += 1;
    if (Array.isArray(arg)) {
      return arg.slice(0, ERROR_LOG_MAX_ARRAY).map((item) => formatErrorLogArg(item, seen, depth + 1, budget));
    }
    if (arg instanceof Map) {
      return formatErrorLogArg(Object.fromEntries(arg.entries()), seen, depth + 1, budget);
    }
    if (!isPlainObject(arg) || hasErrorPayloadKey(arg)) {
      return safeErrorFields(arg);
    }
    const out: Record<string, SafeLogValue> = {};
    for (const [key, nested] of Object.entries(arg)) {
      if (!ERROR_LOG_CONTEXT_KEYS.has(key)) continue;
      if (nested === null) {
        out[key] = null;
      } else if (typeof nested === "boolean") {
        out[key] = nested;
      } else if (typeof nested === "number") {
        out[key] = Number.isFinite(nested) ? nested : null;
      } else if (typeof nested === "string") {
        out[key] = redactText(nested);
      } else {
        out[key] = formatErrorLogArg(nested, seen, depth + 1, budget);
      }
    }
    return out;
  } catch {
    return { category: "error" };
  }
}

export function formatSafeLog(prefix: string, args: unknown[]): string {
  try {
    const parts = args.map((arg) => serializeSafe(redactSensitive(arg)));
    return `[${prefix}] ${parts.join(" ")}`;
  } catch {
    return `[${prefix}] ${UNAVAILABLE}`;
  }
}

export function formatErrorLog(prefix: string, args: unknown[]): string {
  try {
    const parts: string[] = [];
    let seenMessage = false;
    for (const arg of args) {
      if (!seenMessage && typeof arg === "string") {
        seenMessage = true;
        parts.push(redactText(arg));
        continue;
      }
      parts.push(serializeSafe(formatErrorLogArg(arg)));
    }
    return `[${prefix}] ${parts.join(" ")}`;
  } catch {
    return `[${prefix}] ${UNAVAILABLE}`;
  }
}

function ship(level: "debug" | "info" | "error", prefix: string, message: string) {
  const sink = diagnosticSink;
  if (!sink) return;

  const context = { prefix };
  try {
    const sent =
      level === "debug" ? sink.debug(message, context) : level === "info" ? sink.info(message, context) : sink.error(message, context);
    void Promise.resolve(sent)
      .then(() => sink.flush?.())
      .catch(() => undefined);
  } catch {
    /* never rethrow into the request */
  }
}

function emit(level: "debug" | "info" | "error", prefix: string, args: unknown[]) {
  const message = level === "error" ? formatErrorLog(prefix, args) : formatSafeLog(prefix, args);
  try {
    if (level === "debug") console.log(message);
    else if (level === "info") console.info(message);
    else console.error(message);
  } catch {
    try {
      console.error(`[${prefix}] ${UNAVAILABLE}`);
    } catch {
      /* ignore console failure */
    }
  }
  ship(level, prefix, message);
}

export function debugLog(prefix: string, ...args: unknown[]) {
  emit("debug", prefix, args);
}

export function infoLog(prefix: string, ...args: unknown[]) {
  emit("info", prefix, args);
}

export function errorLog(prefix: string, ...args: unknown[]) {
  emit("error", prefix, args);
}
