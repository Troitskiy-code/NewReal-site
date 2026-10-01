export const REDACTED = "[redacted]";
export const UNAVAILABLE = "[unavailable]";

const MAX_DEPTH = 6;
const MAX_KEYS = 40;
const MAX_ARRAY = 32;

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|set-cookie|database_url|datasource|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|credit.?card|cvv|nnextauth|session/i;

const CONNECTION_STRING =
  /(?:postgres(?:ql)?|mysql|mongodb|redis|amqp|[a-z][a-z0-9+.-]*):\/\/[^\s/'"]+:[^\s/'"]+@[^\s'"\s]+/gi;

const BEARER = /\bBearer\s+\S+/gi;
const COOKIE_HEADER = /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi;
const ASSIGNED_SECRET =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*)(?:"([^"]*)"|'([^']*)'|([^\s'",}]+))/gi;
const JSON_ASSIGNED_SECRET =
  /("(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|access_token|refresh_token|client_secret)")\s*:\s*"(?:\\.|[^"\\])*"/gi;
const JSON_ASSIGNED_SECRET_SINGLE =
  /('(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|access_token|refresh_token|client_secret)')\s*:\s*'(?:\\.|[^'\\])*'/gi;

const ALLOWED_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "EvalError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "PrismaClientKnownRequestError",
  "PrismaClientUnknownRequestError",
  "PrismaClientRustPanicError",
  "PrismaClientInitializationError",
  "PrismaClientValidationError",
]);

const ALLOWED_OAUTH_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
]);

const ALLOWED_HTTP_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
  "ERR_BAD_REQUEST",
  "ERR_BAD_RESPONSE",
  "ERR_NETWORK",
  "ERR_CANCELED",
  "ERR_FR_TOO_MANY_REDIRECTS",
]);

export type SafeLogValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: SafeLogValue }
  | SafeLogValue[];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function redactText(value: string): string {
  let out = value;
  out = out.replace(CONNECTION_STRING, REDACTED);
  out = out.replace(BEARER, `Bearer ${REDACTED}`);
  out = out.replace(COOKIE_HEADER, (match) => {
    const name = match.split(":")[0];
    return `${name}: ${REDACTED}`;
  });
  out = out.replace(ASSIGNED_SECRET, `$1${REDACTED}`);
  out = out.replace(JSON_ASSIGNED_SECRET, `$1:"${REDACTED}"`);
  out = out.replace(JSON_ASSIGNED_SECRET_SINGLE, `$1:'${REDACTED}'`);
  return out;
}

function safeErrorName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return ALLOWED_ERROR_NAMES.has(value) ? value : undefined;
}

function prismaCode(value: unknown): string | undefined {
  if (typeof value === "string" && /^P\d{4}$/.test(value)) return value;
  return undefined;
}

function prismaVersion(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+(?:\.\d+){0,3}$/.test(value) && value.length <= 32) {
    return value;
  }
  return undefined;
}

function oauthCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return ALLOWED_OAUTH_CODES.has(value) ? value : undefined;
}

function httpCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return ALLOWED_HTTP_CODES.has(value) ? value : undefined;
}

function httpStatus(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < 100 || value > 599) return undefined;
  return value;
}

function looksLikePrisma(record: Record<string, unknown>): boolean {
  const code = record.code;
  if (typeof code === "string" && /^P\d{4}$/.test(code)) return true;
  return typeof record.clientVersion === "string" && (record.meta !== undefined || typeof record.code === "string");
}

function looksLikeAxios(record: Record<string, unknown>): boolean {
  return record.isAxiosError === true || record.config !== undefined || record.response !== undefined;
}

function looksLikeOAuth(record: Record<string, unknown>): boolean {
  return (
    typeof record.error_description === "string" ||
    (typeof record.error === "string" && (record.error_uri !== undefined || record.error_description !== undefined))
  );
}

function prismaSafe(record: Record<string, unknown>): Record<string, SafeLogValue> {
  const out: Record<string, SafeLogValue> = { category: "prisma" };
  const code = prismaCode(record.code);
  if (code) out.code = code;
  const version = prismaVersion(record.clientVersion);
  if (version) out.clientVersion = version;
  return out;
}

function axiosSafe(record: Record<string, unknown>): Record<string, SafeLogValue> {
  const out: Record<string, SafeLogValue> = { category: "http" };
  const response = record.response;
  if (response && typeof response === "object") {
    const status = httpStatus((response as { status?: unknown }).status);
    if (status !== undefined) out.status = status;
  }
  const code = httpCode(record.code);
  if (code) out.code = code;
  return out;
}

function oauthSafe(record: Record<string, unknown>): Record<string, SafeLogValue> {
  const out: Record<string, SafeLogValue> = { category: "oauth" };
  const code = oauthCode(record.error) ?? oauthCode(record.code);
  if (code) out.code = code;
  return out;
}

export function isErrorEnvelope(value: unknown): value is Record<string, unknown> | Error {
  try {
    if (!value || typeof value !== "object") return false;
    if (value instanceof Error) return true;
    const record = value as Record<string, unknown>;
    if (looksLikePrisma(record) || looksLikeOAuth(record) || looksLikeAxios(record)) return true;
    const hasMessage = typeof record.message === "string";
    const hasStack = typeof record.stack === "string";
    return (hasMessage && hasStack) || (record.meta !== undefined && (hasMessage || typeof record.code === "string"));
  } catch {
    return false;
  }
}

export function safeErrorFields(value: unknown): Record<string, SafeLogValue> {
  try {
    if (!value || typeof value !== "object") {
      return { category: "error" };
    }
    const record = value as Record<string, unknown>;
    if (looksLikePrisma(record)) return prismaSafe(record);
    if (looksLikeOAuth(record)) return oauthSafe(record);
    if (looksLikeAxios(record)) return axiosSafe(record);
    const out: Record<string, SafeLogValue> = { category: "error" };
    const name = safeErrorName(record.name) ?? (value instanceof Error ? safeErrorName(value.name) : undefined);
    if (name) out.name = name;
    const code = prismaCode(record.code) ?? httpCode(record.code) ?? oauthCode(record.code);
    if (code) out.code = code;
    const status = httpStatus(record.status);
    if (status !== undefined) out.status = status;
    return out;
  } catch {
    return { category: "error" };
  }
}

function redactSensitiveInner(value: unknown, seen: WeakSet<object>, depth: number): SafeLogValue {
  if (depth > MAX_DEPTH) return { category: "truncated" };
  if (typeof value === "string") return redactText(value);
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value !== "object") return { category: "opaque" };

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (isErrorEnvelope(value)) {
    return safeErrorFields(value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => redactSensitiveInner(item, seen, depth + 1));
  }

  if (!isPlainObject(value) && !(value instanceof Map)) {
    return { category: "opaque" };
  }

  const source: Record<string, unknown> =
    value instanceof Map ? Object.fromEntries(value.entries()) : { ...(value as Record<string, unknown>) };
  const out: Record<string, SafeLogValue> = {};
  let count = 0;
  for (const [key, nested] of Object.entries(source)) {
    if (count >= MAX_KEYS) {
      out.truncated = true;
      break;
    }
    count += 1;
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitiveInner(nested, seen, depth + 1);
  }
  return out;
}

export function redactSensitive(value: unknown, seen = new WeakSet<object>(), depth = 0): SafeLogValue {
  try {
    return redactSensitiveInner(value, seen, depth);
  } catch {
    return UNAVAILABLE;
  }
}

export function emailDomain(email: string | null | undefined): string | null {
  if (!email || typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}
