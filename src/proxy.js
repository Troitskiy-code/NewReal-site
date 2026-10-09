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

const PUBLIC_FILE = /\.(?:svg|png|jpg|jpeg|gif|webp|ico|json|xml|txt|woff2?)$/i;

function resolveLocale(request) {
  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(cookieLocale)) return cookieLocale;

  const accept = request.headers.get("accept-language")?.toLowerCase() ?? "";
  if (accept.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

function attachAnonymousCookie(request, response) {
  if (isAuthCookiePresent((name) => request.cookies.get(name))) {
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

export default async function proxy(request) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/locales") ||
    pathname === "/favicon.ico" ||
    pathname === "/sitemap.xml" ||
    pathname === "/robots.txt" ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
  }

  const pathnameLocale = LOCALES.find(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)
  );

  if (pathnameLocale) {
    const stripped = pathname.slice(pathnameLocale.length + 1) || "/";
    const url = request.nextUrl.clone();
    url.pathname = stripped.startsWith("/") ? stripped : `/${stripped}`;
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(LOCALE_HEADER, pathnameLocale);
    // Always overwrite client-supplied values; metadata receives a boolean, never the raw URL.
    requestHeaders.set(PRIVATE_URL_HEADER, isPrivatePageUrl(request.nextUrl) ? "1" : "0");
    const response = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
    response.cookies.set(LOCALE_COOKIE, pathnameLocale, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
    return attachPrivacyHeaders(request, attachAnonymousCookie(request, response));
  }

  // Rewritten locale requests keep x-locale; do not bounce them back to the prefixed URL.
  if (isLocale(request.headers.get(LOCALE_HEADER))) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(PRIVATE_URL_HEADER, isPrivatePageUrl(request.nextUrl) ? "1" : "0");
    return attachPrivacyHeaders(request, attachAnonymousCookie(request, NextResponse.next({ request: { headers: requestHeaders } })));
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
  return attachPrivacyHeaders(request, attachAnonymousCookie(request, response));
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|locales|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|json)).*)",
  ],
};
