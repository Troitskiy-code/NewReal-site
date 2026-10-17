import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { FEATURED_GENRES, type FeaturedGenre } from "@/lib/characterTags";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { getPublicCatalog } from "@/lib/publicCatalog";
import type { GenreId } from "@/lib/genreSeo";
import { catalogTagCondition } from "./characterCatalogSearch";

function publicGenreWhere(tag: string) {
  return { isPublic: true, slug: { not: null }, ...catalogTagCondition(tag) };
}

/** Indexing follows the public catalog, never the viewer's (Telegram-filtered) view of it. */
export const countPublicGenreCharacters = cache(async (tag: string) => {
  try {
    return await prisma.character.count({ where: publicGenreWhere(tag) });
  } catch (error) {
    errorLog("Genres", "public count", toSafeDiagnostic(error));
    throw new Error("Genre catalog temporarily unavailable");
  }
});

export async function getGenrePage(genre: FeaturedGenre, page: number) {
  const [catalog, publicCount] = await Promise.all([
    getPublicCatalog("top", page, "", genre.tag),
    countPublicGenreCharacters(genre.tag),
  ]);
  return { ...catalog, publicCount };
}

/** One count and the latest change per genre, for the sitemap and the genres hub. */
export async function getGenreStats(): Promise<Record<GenreId, { count: number; updatedAt: Date | null }>> {
  try {
    const rows = await Promise.all(FEATURED_GENRES.map(async (genre) => {
      const stats = await prisma.character.aggregate({
        where: publicGenreWhere(genre.tag), _count: { _all: true }, _max: { updatedAt: true },
      });
      return [genre.id, { count: stats._count._all, updatedAt: stats._max.updatedAt }] as const;
    }));
    return Object.fromEntries(rows) as Record<GenreId, { count: number; updatedAt: Date | null }>;
  } catch (error) {
    errorLog("Genres", "stats", toSafeDiagnostic(error));
    throw new Error("Genre catalog temporarily unavailable");
  }
}
