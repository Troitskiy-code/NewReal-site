import type { NextRequest } from "next/server";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from "./i18nConfig";
import { translate } from "./getDictionary";

export function getApiLocale(req: NextRequest): Locale {
  const cookieLocale = req.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(cookieLocale)) return cookieLocale;

  const bodyLocale = req.headers.get("x-locale");
  if (isLocale(bodyLocale)) return bodyLocale;

  const accept = req.headers.get("accept-language")?.toLowerCase() ?? "";
  if (accept.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

export function apiT(
  req: NextRequest,
  key: string,
  vars?: Record<string, string | number>
): string {
  return translate(getApiLocale(req), key, vars);
}
