import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Footer from "@/components/Footer";
import CharacterPublicView from "./CharacterPublicView";
import { prisma } from "@/lib/prisma";
import { findCharacterBySlugForViewer, getViewerId } from "@/lib/characterPublic";
import { createPageMetadata, OG_IMAGE, SITE_URL } from "@/lib/seo";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { translate } from "@/lib/getDictionary";
import { getLocalizedCardDescription, pickLocalizedMemory, pickLocalizedText } from "@/lib/characterFields";

type PageProps = {
  params: Promise<{ slug: string }>;
};

function characterOgImage(imageUrl: string | null): string {
  if (!imageUrl) return OG_IMAGE;
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) return imageUrl;
  if (imageUrl.startsWith("/")) return `${SITE_URL}${imageUrl}`;
  return OG_IMAGE;
}

function truncateDescription(text: string, max = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trim()}…`;
}

export const dynamicParams = true;
export const revalidate = 3600;

export async function generateStaticParams() {
  try {
    const characters = await prisma.character.findMany({
      where: { isPublic: true, slug: { not: null } },
      select: { slug: true },
      orderBy: { totalMessages: "desc" },
      take: 300,
    });
    return characters
      .filter((character): character is { slug: string } => Boolean(character.slug))
      .map((character) => ({ slug: character.slug }));
  } catch (error) {
    console.error("[Character] generateStaticParams failed", error);
    return [];
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const locale = await getRequestLocale();
  const viewerId = await getViewerId();
  const character = await findCharacterBySlugForViewer(slug, viewerId);

  if (!character) {
    return createPageMetadata(
      translate(locale, "meta.character.fallbackTitle"),
      translate(locale, "meta.character.fallbackDescription")
    );
  }

  const name = pickLocalizedText(character.name, character.name_en, locale) ?? character.name;
  const description =
    getLocalizedCardDescription(character, locale) ||
    pickLocalizedMemory(character.publicMemory, character.publicMemory_en, locale) ||
    translate(locale, "meta.character.description", { name });

  const metadata = createPageMetadata(
    translate(locale, "meta.character.title", { name }),
    truncateDescription(description),
    characterOgImage(character.imageUrl)
  );

  if (!character.isPublic) {
    return { ...metadata, robots: { index: false, follow: false } };
  }

  return metadata;
}

export default async function CharacterPage({ params }: PageProps) {
  const { slug } = await params;
  const viewerId = await getViewerId();
  const character = await findCharacterBySlugForViewer(slug, viewerId);

  if (!character) {
    notFound();
  }

  console.log("[Character] View", { slug: character.slug, id: character.id, public: character.isPublic });

  return (
    <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
      <main className="flex-1 px-4 py-8 sm:px-6">
        <CharacterPublicView
          character={{
            ...character,
            createdAt: character.createdAt.toISOString(),
          }}
        />
      </main>
      <Footer />
    </div>
  );
}
