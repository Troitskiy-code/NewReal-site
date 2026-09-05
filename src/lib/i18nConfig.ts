export const LOCALES = ["ru", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ru";
export const LOCALE_COOKIE = "NEXT_LOCALE";
export const LOCALE_HEADER = "x-locale";

export function isLocale(value: string | null | undefined): value is Locale {
  return value === "ru" || value === "en";
}

export function stripLocalePrefix(pathname: string): string {
  const segments = pathname.split("/");
  if (segments[1] && isLocale(segments[1])) {
    const rest = segments.slice(2).join("/");
    return rest ? `/${rest}` : "/";
  }
  return pathname || "/";
}

export function getLocaleFromPath(pathname: string): Locale | null {
  const segment = pathname.split("/")[1];
  return isLocale(segment) ? segment : null;
}

export function withLocale(pathname: string, locale: Locale): string {
  const stripped = stripLocalePrefix(pathname);
  if (stripped === "/") return `/${locale}`;
  return `/${locale}${stripped}`;
}

export function dateLocale(locale: string): string {
  return locale === "en" ? "en-US" : "ru-RU";
}
