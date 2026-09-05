import { NextResponse } from "next/server";
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALES,
  LOCALE_COOKIE,
  LOCALE_HEADER,
  withLocale,
} from "@/lib/i18nConfig";

const PUBLIC_FILE = /\.(?:svg|png|jpg|jpeg|gif|webp|ico|json|xml|txt|woff2?)$/i;

function resolveLocale(request) {
  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(cookieLocale)) return cookieLocale;

  const accept = request.headers.get("accept-language")?.toLowerCase() ?? "";
  if (accept.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
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
    const response = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
    response.cookies.set(LOCALE_COOKIE, pathnameLocale, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
    return response;
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
  return response;
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|locales|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|json)).*)",
  ],
};
