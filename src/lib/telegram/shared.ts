// Telegram Mini App constants shared by the proxy, server code and the browser.
// No server-only imports: this file is bundled into the proxy and client components.

/**
 * Session cookie of a Telegram launch. Separate from the NextAuth cookie: it is
 * SameSite=None; Secure; Partitioned so it also works when Telegram Web frames the app,
 * while the site's own cookie keeps SameSite=Lax. The proxy maps it onto the NextAuth cookie
 * name only for requests that carry the Telegram context cookie.
 */
export const TELEGRAM_SESSION_COOKIE = { secure: "__Secure-nv-tg.session-token", plain: "nv-tg.session-token" } as const;
/** Set after a verified launch, even when sign-in is refused: it hides every purchase element. */
export const TELEGRAM_CONTEXT_COOKIE = { secure: "__Secure-nv-tg.ctx", plain: "nv-tg.ctx" } as const;
/** Request header from the proxy to server components: "1" in the Telegram context. Never trusted from clients. */
export const TELEGRAM_CONTEXT_HEADER = "x-nv-telegram";

export const TELEGRAM_ENTRY_PATH = "/tg";
export const TELEGRAM_UNAVAILABLE_PATH = "/tg/unavailable";

/** Shop pages. In Telegram they render a neutral page without prices or payment links. */
export const TELEGRAM_PURCHASE_PATHS = ["/coins", "/pricing", "/subscription", "/tokens", "/realcoins", "/balance"] as const;
/** Documents with payment terms. In Telegram they are offered only as "open in browser". */
export const TELEGRAM_EXTERNAL_DOC_PATHS = ["/offer", "/refund", "/terms", "/privacy"] as const;
/** Purchase APIs refused in the Telegram context (403, neutral text). Webhooks are not listed. */
export const TELEGRAM_PURCHASE_API_PATHS = [
  "/api/payment/create", "/api/subscription/create", "/api/subscription/change",
  "/api/coins/purchase", "/api/coins/offer", "/api/checkout", "/api/billing/checkout",
] as const;

/** Telegram Web frames the Mini App; Telegram Desktop and mobile clients open it top-level. */
export const TELEGRAM_FRAME_ANCESTORS = "frame-ancestors 'self' https://telegram.org https://*.telegram.org";

export function secureTelegramCookies(nextAuthUrl = process.env.NEXTAUTH_URL): boolean {
  return (nextAuthUrl ?? "").startsWith("https://");
}

export function telegramCookieNames(secure = secureTelegramCookies()) {
  return {
    session: secure ? TELEGRAM_SESSION_COOKIE.secure : TELEGRAM_SESSION_COOKIE.plain,
    context: secure ? TELEGRAM_CONTEXT_COOKIE.secure : TELEGRAM_CONTEXT_COOKIE.plain,
    nextAuthSession: secure ? "__Secure-next-auth.session-token" : "next-auth.session-token",
  };
}

function matchesPath(pathname: string, paths: readonly string[]): boolean {
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export function isTelegramPurchasePath(pathname: string): boolean {
  return matchesPath(pathname, TELEGRAM_PURCHASE_PATHS);
}

export function isTelegramExternalDocPath(pathname: string): boolean {
  return matchesPath(pathname, TELEGRAM_EXTERNAL_DOC_PATHS);
}

export function isTelegramPurchaseApiPath(pathname: string): boolean {
  return matchesPath(pathname, TELEGRAM_PURCHASE_API_PATHS);
}

export function isTelegramEntryPath(pathname: string): boolean {
  return pathname === TELEGRAM_ENTRY_PATH || pathname.startsWith(`${TELEGRAM_ENTRY_PATH}/`);
}

const LABEL = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/i;

/**
 * startapp / start payload: "<campaign>", "c_<slug>" or "<campaign>__c_<slug>".
 * The campaign goes to utm_campaign, the slug opens that character. Anything else is ignored.
 * The same grammar is inlined in the launch script of the root layout (verify script compares).
 */
export function parseTelegramStartParam(raw: unknown): { campaign: string | null; characterSlug: string | null } {
  const result = { campaign: null as string | null, characterSlug: null as string | null };
  if (typeof raw !== "string" || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return result;
  for (const part of raw.split("__")) {
    if (part.startsWith("c_")) {
      const slug = part.slice(2);
      if (SLUG.test(slug)) result.characterSlug = slug.toLowerCase();
    } else if (part.startsWith("link_") || part.startsWith("ref_")) {
      continue;
    } else if (LABEL.test(part) && !result.campaign) {
      result.campaign = part;
    }
  }
  return result;
}

export function normalizeTelegramReferralCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{4,32}$/.test(code) ? code : null;
}

/** Reserved startapp segment; it is not an advertising campaign. */
export function telegramReferralFromStartParam(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const segment = raw.split("__").find((part) => part.startsWith("ref_"));
  return normalizeTelegramReferralCode(segment?.slice(4));
}
