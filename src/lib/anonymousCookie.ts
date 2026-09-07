export const ANONYMOUS_SESSION_COOKIE = "anonymousSessionId";
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

export function isValidAnonymousSessionId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
}
