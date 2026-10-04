import type { Metadata } from "next";
import { LOCALES, withLocale, type Locale } from "@/lib/i18nConfig";

export const PUBLIC_PAGE_PATHS = {
  home: "/", gallery: "/gallery", pricing: "/pricing", coins: "/coins",
  support: "/support", offer: "/offer", refund: "/refund", terms: "/terms",
  privacy: "/privacy", rules: "/rules",
} as const;

export type SeoSearchParams = Record<string, string | string[] | undefined>;

export function pageIndexingMetadata(
  page: string, locale: Locale, siteUrl: string, searchParams: SeoSearchParams = {},
): Metadata {
  if (!(page in PUBLIC_PAGE_PATHS)) return { robots: { index: false, follow: true } };
  const path = PUBLIC_PAGE_PATHS[page as keyof typeof PUBLIC_PAGE_PATHS];
  const query = new URLSearchParams();
  if (page === "home" || page === "gallery") {
    // Only these parameters change the catalog. Tracking stays in the browser URL,
    // but never enters canonical/hreflang. Preserve meaningful variants as their own URLs.
    for (const key of ["sort", "page", "q"]) {
      const raw = searchParams[key];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (!value || (key === "sort" && value === "top") || (key === "page" && value === "1")) continue;
      query.set(key, value);
    }
  }
  const suffix = query.size ? `?${query}` : "";
  const url = (language: Locale) => `${siteUrl}${withLocale(path, language)}${suffix}`;
  return {
    alternates: {
      canonical: url(locale),
      languages: Object.fromEntries(LOCALES.map((language) => [language, url(language)])),
    },
    // Only the main catalog is a search landing page. Filters/random/personalized
    // views and pagination stay noindex: responsive 24/25-item pages are not stable
    // search documents. Public profiles are discovered via HTML links and sitemap.
    robots: { index: query.size === 0, follow: true },
  };
}
