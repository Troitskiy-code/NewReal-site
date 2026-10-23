import type { MetadataRoute } from "next";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo";
import { LOCALES, withLocale } from "@/lib/i18nConfig";
import { getGenreStats } from "@/lib/genreCatalog";
import { genrePath, indexableGenreIds } from "@/lib/genreSeo";
import { getIndexableCharacterRows } from "@/lib/characterPageData";

export const dynamic = "force-dynamic";

type ChangeFrequency = NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;

const STATIC_PAGES: Array<{
  path: string;
  changeFrequency: ChangeFrequency;
  priority: number;
}> = [
  { path: "/", changeFrequency: "daily", priority: 1 },
  { path: "/pricing", changeFrequency: "weekly", priority: 0.8 },
  { path: "/coins", changeFrequency: "weekly", priority: 0.7 },
  { path: "/support", changeFrequency: "monthly", priority: 0.4 },
  { path: "/offer", changeFrequency: "monthly", priority: 0.3 },
  { path: "/refund", changeFrequency: "monthly", priority: 0.3 },
  { path: "/terms", changeFrequency: "monthly", priority: 0.3 },
  { path: "/privacy", changeFrequency: "monthly", priority: 0.3 },
  { path: "/rules", changeFrequency: "monthly", priority: 0.3 },
  { path: "/genres", changeFrequency: "weekly", priority: 0.6 },
  { path: "/create", changeFrequency: "monthly", priority: 0.7 },
];

/** Thin genres (noindex) stay out until they fill up; failures propagate like the character query. */
async function getGenreEntries(): Promise<MetadataRoute.Sitemap> {
  const stats = await getGenreStats();
  const counts = Object.fromEntries(Object.entries(stats).map(([id, value]) => [id, value.count]));
  return indexableGenreIds(counts).flatMap((id) => LOCALES.map((locale) => ({
    url: `${SITE_URL}${withLocale(genrePath(id), locale)}`,
    lastModified: stats[id].updatedAt ?? undefined,
    changeFrequency: "daily" as const,
    priority: 0.7,
  })));
}

async function getPublicCharacterEntries(): Promise<MetadataRoute.Sitemap> {
  try {
    // Explicit cards are noindex, so they stay out of the sitemap too.
    const characters = await getIndexableCharacterRows();

    return characters.flatMap((character) => {
      if (!character.slug?.trim()) return [];
      return LOCALES.map((locale) => ({
        url: `${SITE_URL}${withLocale(`/character/${character.slug}`, locale)}`,
        lastModified: character.updatedAt,
        changeFrequency: "weekly" as const,
        priority: 0.7,
      }));
    });
  } catch (error) {
    errorLog("Sitemap", "public characters", toSafeDiagnostic(error));
    // Never publish a successful partial sitemap when the character query failed.
    throw new Error("Sitemap temporarily unavailable");
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = STATIC_PAGES.flatMap((page) =>
    LOCALES.map((locale) => ({
      url: `${SITE_URL}${withLocale(page.path, locale)}`,
      changeFrequency: page.changeFrequency,
      priority: page.priority,
    }))
  );

  const [genreEntries, characterEntries] = await Promise.all([getGenreEntries(), getPublicCharacterEntries()]);
  return [...staticEntries, ...genreEntries, ...characterEntries];
}
