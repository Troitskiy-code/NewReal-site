import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo";
import { LOCALES, withLocale } from "@/lib/i18nConfig";

export const dynamic = "force-dynamic";

type ChangeFrequency = NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;

const STATIC_PAGES: Array<{
  path: string;
  changeFrequency: ChangeFrequency;
  priority: number;
}> = [
  { path: "/", changeFrequency: "daily", priority: 1 },
  { path: "/gallery", changeFrequency: "daily", priority: 0.9 },
  { path: "/pricing", changeFrequency: "weekly", priority: 0.8 },
  { path: "/coins", changeFrequency: "weekly", priority: 0.7 },
  { path: "/support", changeFrequency: "monthly", priority: 0.4 },
  { path: "/offer", changeFrequency: "monthly", priority: 0.3 },
  { path: "/refund", changeFrequency: "monthly", priority: 0.3 },
  { path: "/terms", changeFrequency: "monthly", priority: 0.3 },
  { path: "/privacy", changeFrequency: "monthly", priority: 0.3 },
  { path: "/rules", changeFrequency: "monthly", priority: 0.3 },
];

async function getPublicCharacterEntries(): Promise<MetadataRoute.Sitemap> {
  try {
    const characters = await prisma.character.findMany({
      where: { isPublic: true, slug: { not: null } },
      select: { id: true, slug: true, updatedAt: true },
    });

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

  const characterEntries = await getPublicCharacterEntries();
  return [...staticEntries, ...characterEntries];
}
