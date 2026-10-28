import manifest from "../../public/locales/manifest.json" with { type: "json" };

export type Locale = keyof typeof manifest.locales;
export const LOCALES = (Object.keys(manifest.locales) as Locale[]).filter((code) => manifest.locales[code].enabled);
export const DEFAULT_LOCALE = manifest.defaultLocale as Locale;
export const LOCALE_COOKIE = "NEXT_LOCALE";
// Keep the detection mode separate: API requests still need the actual page language.
export const LOCALE_AUTO_COOKIE = "NEXT_LOCALE_AUTO";
export const LOCALE_HEADER = "x-locale";

export function isLocale(value: string | null | undefined): value is Locale {
  return typeof value === "string" && LOCALES.includes(value as Locale);
}

export function resolveLocale(value: string | null | undefined): Locale {
  const normalized = (value ?? "").trim().replaceAll("_", "-").toLowerCase();
  return LOCALES.find((code) => code.toLowerCase() === normalized)
    ?? LOCALES.find((code) => code.toLowerCase() === normalized.split("-")[0])
    ?? LOCALES.find((code) => code.toLowerCase().split("-")[0] === normalized.split("-")[0])
    ?? DEFAULT_LOCALE;
}

export function localeDefinition(locale: string | null | undefined) {
  return manifest.locales[resolveLocale(locale)];
}

/** Shared fallback order for the server, client and character cards; cycles stop here. */
export function localeFallbacks(locale: string | null | undefined): Locale[] {
  const result: Locale[] = [];
  let current = resolveLocale(locale);
  while (!result.includes(current)) {
    result.push(current);
    const next = manifest.locales[current].fallback;
    if (!isLocale(next)) break;
    current = next;
  }
  if (!result.includes(DEFAULT_LOCALE)) result.push(DEFAULT_LOCALE);
  return result;
}

export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  const ranges = (acceptLanguage ?? "").split(",").map((range, index) => {
    const [tag, ...params] = range.trim().split(";");
    const quality = params.find((p) => p.trim().startsWith("q="));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return { tag: tag.toLowerCase(), q, index };
  }).filter(({ q }) => Number.isFinite(q) && q > 0 && q <= 1)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranges) {
    const match = LOCALES.find((code) => code.toLowerCase() === tag)
      ?? LOCALES.find((code) => code.toLowerCase() === tag.split("-")[0])
      ?? LOCALES.find((code) => code.toLowerCase().split("-")[0] === tag.split("-")[0]);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
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
  return localeDefinition(locale).intl;
}

export function isEnglishLocale(locale: string | null | undefined): boolean {
  return (locale ?? "").toLowerCase().split("-")[0] === "en";
}
