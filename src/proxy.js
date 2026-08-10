import { NextResponse } from "next/server";
import { isRestrictedCountry } from "@/lib/nsfw";

const GEO_COOKIE = "geo_country";
const RESTRICT_COOKIE = "restrict_nsfw";
const COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours
const GEO_TIMEOUT_MS = 2000;

function isValidCountryCode(code) {
  return typeof code === "string" && /^[A-Z]{2}$/i.test(code);
}

function getClientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim();
  return request.headers.get("x-real-ip") || "127.0.0.1";
}

async function fetchCountryByIp(ip) {
  if (!ip || ip === "127.0.0.1" || ip === "::1") return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);

    const response = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode`, {
      signal: controller.signal,
      cache: "no-store",
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json();
    const code = data?.countryCode;
    return isValidCountryCode(code) ? code.toUpperCase() : null;
  } catch {
    return null;
  }
}

async function resolveCountry(request) {
  const url = new URL(request.url);
  const queryCountry = url.searchParams.get("country");
  if (isValidCountryCode(queryCountry)) {
    return queryCountry.toUpperCase();
  }

  const cachedCountry = request.cookies.get(GEO_COOKIE)?.value;
  if (isValidCountryCode(cachedCountry)) {
    return cachedCountry.toUpperCase();
  }

  return fetchCountryByIp(getClientIp(request));
}

function applyGeoCookies(response, country, restrictNsfw) {
  if (country) {
    response.cookies.set(GEO_COOKIE, country, {
      maxAge: COOKIE_MAX_AGE,
      path: "/",
      sameSite: "lax",
    });
  }

  response.cookies.set(RESTRICT_COOKIE, restrictNsfw ? "true" : "false", {
    maxAge: COOKIE_MAX_AGE,
    path: "/",
    sameSite: "lax",
  });
}

export default async function proxy(request) {
  const country = await resolveCountry(request);
  const restrictNsfw = isRestrictedCountry(country);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-restrict-nsfw", restrictNsfw ? "true" : "false");
  requestHeaders.set("x-geo-country", country || "");

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  applyGeoCookies(response, country, restrictNsfw);

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
