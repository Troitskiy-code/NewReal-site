export const ANONYMOUS_SESSION_COOKIE = "anonymousSessionId";
export const ANONYMOUS_MESSAGE_LIMIT = 5;
export const ANONYMOUS_TTL_DAYS = 7;
export const ANONYMOUS_COOKIE_MAX_AGE = ANONYMOUS_TTL_DAYS * 60 * 60 * 24;
export const ANONYMOUS_LIMIT_CODE = "ANONYMOUS_LIMIT_EXCEEDED";
export const ANONYMOUS_LIMIT_MESSAGE =
  "Вы использовали все бесплатные сообщения. Зарегистрируйтесь, чтобы продолжить общение";

const AUTH_SESSION_COOKIES = ["next-auth.session-token", "__Secure-next-auth.session-token"];

export function isAuthCookiePresent(getCookie: (name: string) => { value?: string } | undefined): boolean {
  return AUTH_SESSION_COOKIES.some((name) => Boolean(getCookie(name)?.value));
}

export function createAnonymousSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 14)}`;
}

export function createAnonymousRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `req${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

export function isValidAnonymousSessionId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
}

export function isValidAnonymousRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}

export function anonymousCookieOptions(overrides?: { maxAge?: number; expires?: Date }) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: overrides?.maxAge ?? ANONYMOUS_COOKIE_MAX_AGE,
    expires: overrides?.expires,
    secure: process.env.NODE_ENV === "production",
  };
}

export function anonymousExpiryFrom(now = new Date()): Date {
  return new Date(now.getTime() + ANONYMOUS_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function isAnonymousExpired(
  expiresAt: Date | string | null | undefined,
  createdAt?: Date | string | null,
  now = new Date()
): boolean {
  const expirySource = expiresAt ?? (createdAt ? anonymousExpiryFrom(new Date(createdAt)) : null);
  if (!expirySource) return true;
  return new Date(expirySource).getTime() <= now.getTime();
}
