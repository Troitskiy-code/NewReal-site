import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";
import { SITE_URL } from "@/lib/seo";

export const revalidate = 3600;

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
  { path: "/create", changeFrequency: "weekly", priority: 0.6 },
  { path: "/referral", changeFrequency: "monthly", priority: 0.5 },
  { path: "/profile", changeFrequency: "monthly", priority: 0.4 },
  { path: "/subscription", changeFrequency: "monthly", priority: 0.4 },
  { path: "/support", changeFrequency: "monthly", priority: 0.4 },
  { path: "/offer", changeFrequency: "monthly", priority: 0.3 },
  { path: "/refund", changeFrequency: "monthly", priority: 0.3 },
  { path: "/terms", changeFrequency: "monthly", priority: 0.3 },
];

async function getPublicCharacterEntries(): Promise<MetadataRoute.Sitemap> {
  try {
    const characters = await prisma.character.findMany({
      where: { isPublic: true },
      select: { id: true, updatedAt: true },
    });

    return characters.map((character) => ({
      url: `${SITE_URL}/chat/${character.id}`,
      lastModified: character.updatedAt,
      changeFrequency: "weekly",
      priority: 0.7,
    }));
  } catch (error) {
    console.error("Failed to load public characters for sitemap:", error);
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticEntries: MetadataRoute.Sitemap = STATIC_PAGES.map((page) => ({
    url: `${SITE_URL}${page.path}`,
    lastModified: now,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));

  const characterEntries = await getPublicCharacterEntries();
  return [...staticEntries, ...characterEntries];
}
