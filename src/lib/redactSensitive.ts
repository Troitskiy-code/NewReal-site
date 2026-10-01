const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|set-cookie|database_url|datasource|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|credit.?card|cvv|nnextauth|session/i;

const CONNECTION_STRING = /(?:postgres(?:ql)?|mysql|mongodb|redis|amqp):\/\/[^\s'"]+/i;
const INLINE_SECRET = /((?:password|passwd|secret|token|api[_-]?key|authorization|bearer)\s*[=:]\s*)([^\s'",}]+)/gi;

export const REDACTED = "[redacted]";

export type SafeLogValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: SafeLogValue }
  | SafeLogValue[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function redactText(value: string): string {
  if (CONNECTION_STRING.test(value)) {
    return value.replace(CONNECTION_STRING, REDACTED);
  }
  return value.replace(INLINE_SECRET, `$1${REDACTED}`);
}

function prismaSafe(value: Record<string, unknown>): Record<string, SafeLogValue> {
  const out: Record<string, SafeLogValue> = { category: "prisma" };
  if (typeof value.code === "string") out.code = value.code;
  if (typeof value.clientVersion === "string") out.clientVersion = value.clientVersion;
  return out;
}

function axiosSafe(value: Record<string, unknown>): Record<string, SafeLogValue> {
  const out: Record<string, SafeLogValue> = { category: "http" };
  const response = value.response;
  if (response && typeof response === "object") {
    const status = (response as { status?: unknown }).status;
    if (typeof status === "number") out.status = status;
  }
  if (typeof value.code === "string") out.code = value.code;
  return out;
}

export function safeErrorFields(value: unknown): Record<string, SafeLogValue> {
  if (!value || typeof value !== "object") {
    return { category: "error" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code === "string" && (record.clientVersion || record.meta)) {
    return prismaSafe(record);
  }
  if (record.isAxiosError === true || record.response || record.config) {
    return axiosSafe(record);
  }
  if (value instanceof Error) {
    return {
      category: "error",
      name: value.name,
      message: redactText(value.message),
    };
  }
  return { category: "error" };
}

export function redactSensitive(value: unknown, seen = new WeakSet<object>()): SafeLogValue {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (value === undefined) {
    return null;
  }
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  if (value === null) return null;
  if (value instanceof Error) {
    return safeErrorFields(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string" && (record.clientVersion || record.meta)) {
      return prismaSafe(record);
    }
    if (record.isAxiosError === true || record.response || record.config) {
      return axiosSafe(record);
    }
    if (!isPlainObject(value) && !(value instanceof Map)) {
      return { category: "opaque" };
    }
    const source: Record<string, unknown> =
      value instanceof Map ? Object.fromEntries(value.entries()) : { ...record };
    const out: Record<string, SafeLogValue> = {};
    for (const [key, nested] of Object.entries(source)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(nested, seen);
    }
    return out;
  }
  return { category: "opaque" };
}

export function emailDomain(email: string | null | undefined): string | null {
  if (!email || typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}
