import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Footer from "@/components/Footer";
import JsonLd from "@/components/JsonLd";
import CharacterPublicView from "./CharacterPublicView";
import { findCharacterBySlugForViewer, getViewerId } from "@/lib/characterPublic";
import { createPageMetadata, OG_IMAGE, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, SITE_URL } from "@/lib/seo";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { translate } from "@/lib/getDictionary";
import { getLocalizedCardDescription, pickLocalizedMemory, pickLocalizedText } from "@/lib/characterFields";
import { absoluteAssetUrl, absoluteSiteUrl, buildCharacterJsonLd } from "@/lib/jsonLd";
import { withLocale } from "@/lib/i18nConfig";

type PageProps = {
  params: Promise<{ slug: string }>;
};

function characterOgImage(imageUrl: string | null | undefined): string {
  if (!imageUrl || imageUrl.startsWith("data:")) return OG_IMAGE;
  return absoluteAssetUrl(imageUrl);
}

function truncateDescription(text: string, max = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trim()}…`;
}

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const locale = await getRequestLocale();

  try {
    const viewerId = await getViewerId();
    const character = await findCharacterBySlugForViewer(slug, viewerId);

    if (!character) {
      return createPageMetadata(
        translate(locale, "meta.character.fallbackTitle"),
        translate(locale, "meta.character.fallbackDescription")
      );
    }

    const name = pickLocalizedText(character.name, character.name_en, locale) ?? character.name ?? "";
    const description =
      getLocalizedCardDescription(character, locale) ||
      pickLocalizedMemory(character.publicMemory, character.publicMemory_en, locale) ||
      translate(locale, "meta.character.description", { name: name || "Character" });
    const truncatedDescription = truncateDescription(description || "");
    const image = characterOgImage(character.imageUrl);
    const pageUrl = absoluteSiteUrl(`/character/${character.slug ?? slug}`, locale);
    const metadata = createPageMetadata(
      translate(locale, "meta.character.title", { name: name || "Character" }),
      truncatedDescription,
      image
    );

    const result: Metadata = {
      ...metadata,
      openGraph: {
        ...metadata.openGraph,
        title: name,
        description: truncatedDescription,
        images: [{ url: image, width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, alt: name }],
        type: "profile",
        url: pageUrl,
      },
      twitter: {
        card: "summary_large_image",
        title: name,
        description: truncatedDescription,
        images: [image],
      },
      alternates: {
        canonical: pageUrl,
        languages: {
          ru: `${SITE_URL}${withLocale(`/character/${character.slug ?? slug}`, "ru")}`,
          en: `${SITE_URL}${withLocale(`/character/${character.slug ?? slug}`, "en")}`,
        },
      },
    };

    if (!character.isPublic) {
      return { ...result, robots: { index: false, follow: false } };
    }

    return result;
  } catch (error) {
    console.error("[Character] generateMetadata failed", { slug, error });
    return createPageMetadata(
      translate(locale, "meta.character.fallbackTitle"),
      translate(locale, "meta.character.fallbackDescription")
    );
  }
}

export default async function CharacterPage({ params }: PageProps) {
  const { slug } = await params;
  const locale = await getRequestLocale();
  const viewerId = await getViewerId();
  const character = await findCharacterBySlugForViewer(slug, viewerId);

  if (!character) {
    notFound();
  }

  console.log("[Character] View", { slug: character.slug, id: character.id, public: character.isPublic });

  const name = pickLocalizedText(character.name, character.name_en, locale) ?? character.name;
  const description =
    getLocalizedCardDescription(character, locale) ||
    pickLocalizedMemory(character.publicMemory, character.publicMemory_en, locale) ||
    "";

  return (
    <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
      {character.isPublic ? (
        <JsonLd
          data={buildCharacterJsonLd(
            {
              slug: character.slug,
              name,
              description,
              imageUrl: character.imageUrl,
              createdAt: character.createdAt,
              totalMessages: character.totalMessages,
              authorName: character.user?.name ?? null,
            },
            locale
          )}
        />
      ) : null}
      <main className="flex-1 px-4 py-8 sm:px-6">
        <CharacterPublicView
          character={{
            id: character.id,
            slug: character.slug,
            name: character.name,
            name_en: character.name_en,
            description: character.description,
            description_en: character.description_en,
            descriptionCard: character.descriptionCard,
            descriptionCard_en: character.descriptionCard_en,
            imageUrl: character.imageUrl,
            publicMemory: character.publicMemory,
            publicMemory_en: character.publicMemory_en,
            totalMessages: character.totalMessages ?? 0,
            createdAt: character.createdAt.toISOString(),
            user: {
              name: character.user?.name ?? null,
              image: character.user?.image ?? null,
            },
          }}
        />
      </main>
      <Footer />
    </div>
  );
}
