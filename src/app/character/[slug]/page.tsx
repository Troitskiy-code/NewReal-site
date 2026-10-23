import type { Metadata } from "next";
import Footer from "@/components/Footer";
import JsonLd from "@/components/JsonLd";
import CharacterPublicView from "./CharacterPublicView";
import { CharacterFaq, characterFaq, CharacterStory, SimilarCharacters } from "./CharacterPageSections";
import { getCharacterPageData, getCharacterStory, getSimilarCharacters } from "@/lib/characterPageData";
import { createPageMetadata, OG_IMAGE, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, SITE_URL } from "@/lib/seo";
import { translate } from "@/lib/getDictionary";
import { getLocalizedCardDescription, pickLocalizedMemory, pickLocalizedText } from "@/lib/characterFields";
import { absoluteAssetUrl, absoluteSiteUrl, buildCharacterJsonLd } from "@/lib/jsonLd";
import { isEnglishLocale, withLocale } from "@/lib/i18nConfig";

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

    const { character, locale } = await getCharacterPageData(slug);

    const name = pickLocalizedText(character.name, character.name_en, locale) ?? character.name ?? "";
    // Without its own English text the EN page would repeat the Russian description; the
    // template keeps the two language versions distinct for search engines.
    const hasOwnText = !isEnglishLocale(locale) || Boolean(character.descriptionCard_en?.trim() || character.description_en?.trim());
    const description =
      (hasOwnText ? getLocalizedCardDescription(character, locale) : null) ||
      (hasOwnText ? pickLocalizedMemory(character.publicMemory, character.publicMemory_en, locale) : null) ||
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
    // Explicit cards stay reachable but out of the index (and out of the sitemap).
    if ((await getCharacterStory(slug)).adult) {
      return { ...result, robots: { index: false, follow: true } };
    }

    return result;
}

export default async function CharacterPage({ params }: PageProps) {
  const { slug } = await params;
  const { character, locale, view } = await getCharacterPageData(slug);
  const [{ story }, similar] = await Promise.all([getCharacterStory(slug), getSimilarCharacters(character)]);
  const name = pickLocalizedText(character.name, character.name_en, locale) ?? character.name;
  const description = truncateDescription(
    getLocalizedCardDescription(character, locale) ||
    pickLocalizedMemory(character.publicMemory, character.publicMemory_en, locale) ||
    ""
  );

  return (
    <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
      {character.isPublic ? (
        <JsonLd
          data={buildCharacterJsonLd(
            {
              slug: character.slug,
              name,
              description,
              // The avatar route path, never inline image data.
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
          character={view}
          story={story ? <CharacterStory story={story} name={name} locale={locale} /> : null}
        />
        <div className="mx-auto mt-10 flex w-full max-w-3xl flex-col gap-10">
          <SimilarCharacters characters={similar} locale={locale} />
          <CharacterFaq items={characterFaq(locale, name)} locale={locale} />
        </div>
      </main>
      <Footer />
    </div>
  );
}
