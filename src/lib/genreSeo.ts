import type { Metadata } from "next";
import { FEATURED_GENRES, type FeaturedGenre } from "@/lib/characterTags";
import { LOCALES, withLocale, type Locale } from "@/lib/i18nConfig";

/**
 * A genre page with fewer public characters stays noindex,follow and out of the sitemap.
 * Counts are read on every request, so a genre becomes indexable as soon as it fills up.
 */
export const GENRE_INDEX_MIN_CHARACTERS = 8;

export const GENRES_PATH = "/genres";

export type GenreId = FeaturedGenre["id"];

export function genrePath(id: GenreId): string {
  return `${GENRES_PATH}/${id}`;
}

export function findFeaturedGenre(id: string): FeaturedGenre | null {
  return FEATURED_GENRES.find((genre) => genre.id === id) ?? null;
}

export function isGenreIndexable(publicCount: number): boolean {
  return publicCount >= GENRE_INDEX_MIN_CHARACTERS;
}

/** ?page=1, garbage and tracking parameters all share the first page's canonical. */
export function parseGenrePage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return Math.max(1, Number.parseInt(value ?? "", 10) || 1);
}

export function genrePageUrl(siteUrl: string, id: GenreId, locale: Locale, page = 1): string {
  return `${siteUrl}${withLocale(genrePath(id), locale)}${page > 1 ? `?page=${page}` : ""}`;
}

/** Canonical and hreflang point at the same page number; thin genres are noindex on every page. */
export function genreIndexingMetadata(
  id: GenreId, locale: Locale, siteUrl: string, { page, publicCount }: { page: number; publicCount: number },
): Metadata {
  return {
    alternates: {
      canonical: genrePageUrl(siteUrl, id, locale, page),
      languages: Object.fromEntries(LOCALES.map((language) => [language, genrePageUrl(siteUrl, id, language, page)])),
    },
    robots: { index: isGenreIndexable(publicCount), follow: true },
  };
}

/** Only the first page of each filled genre goes into the sitemap. */
export function indexableGenreIds(counts: Partial<Record<GenreId, number>>): GenreId[] {
  return FEATURED_GENRES.filter((genre) => isGenreIndexable(counts[genre.id] ?? 0)).map((genre) => genre.id);
}
