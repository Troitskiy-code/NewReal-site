const ALLOWED_PREFIXES = [
  "/",
  "/chat/",
  "/chats",
  "/pricing",
  "/coins",
  "/profile",
  "/create",
  "/gallery",
  "/support",
  "/character/",
];

const DEFAULT_CALLBACK = "/";
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function looksLikeAbsoluteUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith("//");
}

function decodeOnce(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isAllowedPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return ALLOWED_PREFIXES.some((prefix) => prefix !== "/" && (pathname === prefix || pathname.startsWith(prefix)));
}

export function sanitizeCallbackUrl(raw: unknown, fallback = DEFAULT_CALLBACK): string {
  if (typeof raw !== "string") return fallback;

  const original = raw.trim();
  if (!original || CONTROL_CHARS.test(original)) return fallback;

  const once = decodeOnce(original);
  if (once == null) return fallback;
  if (once !== original) {
    const twice = decodeOnce(once);
    if (twice != null && twice !== once) return fallback;
  }

  const value = (once !== original ? once : original).trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  if (looksLikeAbsoluteUrl(value) || value.includes("://")) return fallback;
  if (CONTROL_CHARS.test(value)) return fallback;

  const [pathAndQuery] = value.split("#");
  if (!pathAndQuery || !pathAndQuery.startsWith("/") || pathAndQuery.startsWith("//")) return fallback;

  const pathname = pathAndQuery.split("?")[0] ?? "";
  if (!isAllowedPath(pathname)) return fallback;
  return pathAndQuery;
}

export function callbackUrlFromSearchParam(raw: string | null | undefined): string {
  return sanitizeCallbackUrl(raw, "/");
}
