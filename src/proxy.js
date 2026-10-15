import { NextResponse } from "next/server";
import { isPrivatePageUrl, PRIVATE_URL_HEADER } from "@/lib/urlPrivacy";
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALES,
  LOCALE_COOKIE,
  LOCALE_HEADER,
  withLocale,
} from "@/lib/i18nConfig";
import {
  ANONYMOUS_SESSION_COOKIE,
  anonymousCookieOptions,
  createAnonymousSessionId,
  isAuthCookiePresent,
  isValidAnonymousSessionId,
} from "@/lib/anonymousCookie";
import {
  isTelegramEntryPath,
  isTelegramExternalDocPath,
  isTelegramPurchaseApiPath,
  isTelegramPurchasePath,
  TELEGRAM_CONTEXT_COOKIE,
  TELEGRAM_CONTEXT_HEADER,
  TELEGRAM_ENTRY_PATH,
  TELEGRAM_FRAME_ANCESTORS,
  TELEGRAM_UNAVAILABLE_PATH,
  telegramCookieNames,
  normalizeTelegramReferralCode,
} from "@/lib/telegram/shared";

const PUBLIC_FILE = /\.(?:svg|png|jpg|jpeg|gif|webp|ico|json|xml|txt|woff2?)$/i;
const NEXT_AUTH_SESSION_COOKIE = /^(?:__Secure-)?next-auth\.session-token(?:\.\d+)?$/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function resolveLocale(request) {
  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(cookieLocale)) return cookieLocale;

  const accept = request.headers.get("accept-language")?.toLowerCase() ?? "";
  if (accept.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

function isTelegramMiniAppEnabled() {
  return ["1", "true"].includes(String(process.env.TELEGRAM_MINIAPP_ENABLED ?? "").trim().toLowerCase());
}

/** Telegram state of the request. The context cookie is only ever set after a verified launch. */
function telegramState(request) {
  const names = telegramCookieNames();
  const context = Boolean(
    request.cookies.get(TELEGRAM_CONTEXT_COOKIE.secure)?.value || request.cookies.get(TELEGRAM_CONTEXT_COOKIE.plain)?.value
  );
  return { context, session: context ? request.cookies.get(names.session)?.value ?? "" : "", names };
}

function isSameOriginWrite(request) {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("origin");
  try {
    return Boolean(origin) && new URL(origin).host === request.nextUrl.host;
  } catch {
    return false;
  }
}

/**
 * Presents the Telegram session cookie to NextAuth under its own cookie name, replacing any
 * site session in this request. The Telegram cookie is SameSite=None, so writes authenticated
 * by it must be same-origin (CSRF guard); otherwise the request continues without a session.
 */
function applyTelegramSession(request, headers, tg) {
  if (!tg.session || !isTelegramMiniAppEnabled()) return;
  if (!SAFE_METHODS.has(request.method) && !isSameOriginWrite(request)) return;
  const kept = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !NEXT_AUTH_SESSION_COOKIE.test(part.split("=")[0].trim()));
  kept.push(`${tg.names.nextAuthSession}=${tg.session}`);
  headers.set("cookie", kept.join("; "));
}

function attachAnonymousCookie(request, response, tg) {
  if (isAuthCookiePresent((name) => request.cookies.get(name)) || (tg?.context && tg.session)) {
    return response;
  }

  const existing = request.cookies.get(ANONYMOUS_SESSION_COOKIE)?.value;
  if (isValidAnonymousSessionId(existing)) {
    return response;
  }

  response.cookies.set(ANONYMOUS_SESSION_COOKIE, createAnonymousSessionId(), anonymousCookieOptions());
  console.log("[Anonymous] Issued session cookie");
  return response;
}

function attachPrivacyHeaders(request, response) {
  // Origin-only referrers also protect same-origin navigation away from a token URL.
  response.headers.set("Referrer-Policy", isPrivatePageUrl(request.nextUrl) ? "no-referrer" : "strict-origin");
  if (isPrivatePageUrl(request.nextUrl)) {
    response.headers.set("X-Robots-Tag", "noindex, follow");
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}

function attachTelegramHeaders(response, telegram, strippedPath) {
  if (!telegram) return response;
  // Only Telegram may frame the app in this context; other responses are unchanged.
  response.headers.set("Content-Security-Policy", TELEGRAM_FRAME_ANCESTORS);
  response.headers.set("Cache-Control", "private, no-store");
  if (isTelegramEntryPath(strippedPath)) response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

/** In Telegram, shop pages and documents with payment terms become one neutral page. */
function telegramRewriteTarget(url, strippedPath) {
  // A Telegram user gets an account by signing in with Telegram, not with the site form (offer).
  if (strippedPath === "/register") {
    const entry = url.clone();
    entry.pathname = TELEGRAM_ENTRY_PATH;
    entry.search = "";
    const referral = normalizeTelegramReferralCode(url.searchParams.get("ref"));
    if (referral) entry.searchParams.set("ref", referral);
    return entry;
  }
  const shop = isTelegramPurchasePath(strippedPath);
  if (!shop && !isTelegramExternalDocPath(strippedPath)) return null;
  const target = url.clone();
  target.pathname = TELEGRAM_UNAVAILABLE_PATH;
  target.search = "";
  if (shop) target.searchParams.set("section", "shop");
  else {
    target.searchParams.set("section", "document");
    target.searchParams.set("doc", strippedPath.split("/")[1]);
  }
  return target;
}

function pageRequestHeaders(request, telegram, tg) {
  const requestHeaders = new Headers(request.headers);
  // Always overwrite client-supplied values; metadata receives a boolean, never the raw URL.
  requestHeaders.set(PRIVATE_URL_HEADER, isPrivatePageUrl(request.nextUrl) ? "1" : "0");
  requestHeaders.set(TELEGRAM_CONTEXT_HEADER, telegram ? "1" : "0");
  if (telegram) applyTelegramSession(request, requestHeaders, tg);
  return requestHeaders;
}

function apiProxy(request, tg) {
  // The matcher sends /api here only with a Telegram context cookie.
  if (!tg.context) return NextResponse.next();
  if (isTelegramPurchaseApiPath(request.nextUrl.pathname)) {
    return NextResponse.json(
      { error: "Этот раздел недоступен в Telegram", code: "TELEGRAM_UNAVAILABLE" },
      { status: 403, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(TELEGRAM_CONTEXT_HEADER, "1");
  applyTelegramSession(request, requestHeaders, tg);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export default async function proxy(request) {
  const { pathname } = request.nextUrl;
  const tg = telegramState(request);

  if (pathname.startsWith("/api")) return apiProxy(request, tg);

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/locales") ||
    pathname === "/favicon.ico" ||
    pathname === "/sitemap.xml" ||
    pathname === "/robots.txt" ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
  }

  // The Mini App URL is /tg without a locale: render it in place. A redirect would have to
  // carry the launch data in the URL fragment through another navigation.
  const bareTelegramEntry = isTelegramEntryPath(pathname);
  const pathnameLocale = bareTelegramEntry
    ? resolveLocale(request)
    : LOCALES.find((locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`));

  if (pathnameLocale) {
    const stripped = bareTelegramEntry ? pathname : pathname.slice(pathnameLocale.length + 1) || "/";
    const strippedPath = stripped.startsWith("/") ? stripped : `/${stripped}`;
    const telegram = tg.context || isTelegramEntryPath(strippedPath);
    const url = request.nextUrl.clone();
    url.pathname = strippedPath;
    const requestHeaders = pageRequestHeaders(request, telegram, tg);
    requestHeaders.set(LOCALE_HEADER, pathnameLocale);
    const target = (telegram && telegramRewriteTarget(url, strippedPath)) || url;
    const response = NextResponse.rewrite(target, { request: { headers: requestHeaders } });
    if (!bareTelegramEntry) {
      response.cookies.set(LOCALE_COOKIE, pathnameLocale, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
        sameSite: "lax",
      });
    }
    return attachTelegramHeaders(
      attachPrivacyHeaders(request, attachAnonymousCookie(request, response, tg)),
      telegram,
      strippedPath
    );
  }

  // Rewritten locale requests keep x-locale; do not bounce them back to the prefixed URL.
  if (isLocale(request.headers.get(LOCALE_HEADER))) {
    const telegram = tg.context || isTelegramEntryPath(pathname);
    const requestHeaders = pageRequestHeaders(request, telegram, tg);
    const target = telegram ? telegramRewriteTarget(request.nextUrl, pathname) : null;
    const response = target
      ? NextResponse.rewrite(target, { request: { headers: requestHeaders } })
      : NextResponse.next({ request: { headers: requestHeaders } });
    return attachTelegramHeaders(
      attachPrivacyHeaders(request, attachAnonymousCookie(request, response, tg)),
      telegram,
      pathname
    );
  }

  const locale = resolveLocale(request);
  const url = request.nextUrl.clone();
  url.pathname = withLocale(pathname, locale);
  const response = NextResponse.redirect(url);
  response.cookies.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  return attachTelegramHeaders(attachPrivacyHeaders(request, attachAnonymousCookie(request, response, tg)), tg.context, pathname);
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|locales|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|json)).*)",
    // API requests pass through the proxy only inside Telegram (session mapping, purchase block).
    { source: "/api/:path*", has: [{ type: "cookie", key: "__Secure-nv-tg.ctx" }] },
    { source: "/api/:path*", has: [{ type: "cookie", key: "nv-tg.ctx" }] },
  ],
};
