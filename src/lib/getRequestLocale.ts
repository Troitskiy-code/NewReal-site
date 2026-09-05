import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, LOCALE_HEADER, type Locale } from "./i18nConfig";

export async function getRequestLocale(): Promise<Locale> {
  const headerList = await headers();
  const headerLocale = headerList.get(LOCALE_HEADER);
  if (isLocale(headerLocale)) return headerLocale;

  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isLocale(cookieLocale)) return cookieLocale;

  return DEFAULT_LOCALE;
}
