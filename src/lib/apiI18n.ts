import type { NextRequest } from "next/server";
import { isLocale, negotiateLocale, LOCALE_COOKIE, LOCALE_HEADER, type Locale } from "./i18nConfig";
import { translate } from "./getDictionary";

export function getApiLocale(req: NextRequest): Locale {
  const bodyLocale = req.headers.get(LOCALE_HEADER);
  if (isLocale(bodyLocale)) return bodyLocale;

  const cookieLocale = req.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(cookieLocale)) return cookieLocale;
  return negotiateLocale(req.headers.get("accept-language"));
}

export function apiT(
  req: NextRequest,
  key: string,
  vars?: Record<string, string | number>
): string {
  return translate(getApiLocale(req), key, vars);
}
