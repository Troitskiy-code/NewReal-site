import { dateLocale, withLocale, type Locale } from "@/lib/i18nConfig";
import { SITE_URL } from "@/lib/seo";
import { brandAssetUrl } from "@/lib/brand.mjs";
import { translate } from "@/lib/getDictionary";

const DEFAULT_BRAND_IMAGE = `${SITE_URL}${brandAssetUrl("/logo.png")}`;

export function absoluteSiteUrl(pathname: string, locale: Locale): string {
  return `${SITE_URL}${withLocale(pathname, locale)}`;
}

export function absoluteAssetUrl(path: string | null | undefined): string {
  if (!path || path.startsWith("data:")) return DEFAULT_BRAND_IMAGE;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (path.startsWith("/")) return `${SITE_URL}${path}`;
  return DEFAULT_BRAND_IMAGE;
}

type CharacterJsonLdInput = {
  slug: string;
  name: string;
  description: string;
  imageUrl: string | null;
  createdAt: Date;
  totalMessages: number;
  authorName: string | null;
};

export function buildCharacterJsonLd(character: CharacterJsonLdInput, locale: Locale) {
  const pageUrl = absoluteSiteUrl(`/character/${character.slug}`, locale);
  const homeUrl = absoluteSiteUrl("/", locale);
  const fallbackDescription =
    translate(locale, "structuredData.chatDescription", { name: character.name });
  const description = character.description.trim() || fallbackDescription;
  const authorName =
    character.authorName?.trim() || translate(locale, "structuredData.author");

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": pageUrl,
        url: pageUrl,
        name: character.name,
        description,
        inLanguage: dateLocale(locale),
        isPartOf: {
          "@type": "WebSite",
          "@id": SITE_URL,
          name: "NewVerse",
          url: SITE_URL,
        },
      },
      {
        "@type": "Person",
        "@id": `${pageUrl}#person`,
        name: character.name,
        description,
        image: absoluteAssetUrl(character.imageUrl),
        url: pageUrl,
        creator: {
          "@type": "Person",
          name: authorName,
          url: absoluteSiteUrl("/profile", locale),
        },
        dateCreated: character.createdAt.toISOString(),
        interactionStatistic: {
          "@type": "InteractionCounter",
          interactionType: "https://schema.org/CommentAction",
          userInteractionCount: character.totalMessages || 0,
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: translate(locale, "structuredData.home"),
            item: homeUrl,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: character.name,
            item: pageUrl,
          },
        ],
      },
    ],
  };
}

export function buildWebsiteJsonLd(locale: Locale) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "NewVerse",
    url: SITE_URL,
    inLanguage: dateLocale(locale),
    potentialAction: {
      "@type": "SearchAction",
      target: `${absoluteSiteUrl("/", locale)}?q={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  };
}

type GenreJsonLdInput = {
  /** First-page URL (breadcrumb) and this page's URL (CollectionPage). */
  genreUrl: string;
  pageUrl: string;
  name: string;
  description: string;
  hubName: string;
  /** Position of the first character on this page in the whole genre list. */
  offset: number;
  characters: Array<{ slug: string | null; name: string }>;
};

export function buildGenreJsonLd(input: GenreJsonLdInput, locale: Locale) {
  const items = input.characters.filter((character) => character.slug);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        "@id": input.pageUrl,
        url: input.pageUrl,
        name: input.name,
        description: input.description,
        inLanguage: dateLocale(locale),
        isPartOf: { "@type": "WebSite", "@id": SITE_URL, name: "NewVerse", url: SITE_URL },
        mainEntity: { "@id": `${input.pageUrl}#characters` },
        breadcrumb: { "@id": `${input.pageUrl}#breadcrumb` },
      },
      {
        "@type": "ItemList",
        "@id": `${input.pageUrl}#characters`,
        itemListOrder: "https://schema.org/ItemListOrderDescending",
        numberOfItems: items.length,
        itemListElement: items.map((character, index) => ({
          "@type": "ListItem",
          position: input.offset + index + 1,
          name: character.name,
          url: absoluteSiteUrl(`/character/${character.slug}`, locale),
        })),
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${input.pageUrl}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: translate(locale, "structuredData.home"), item: absoluteSiteUrl("/", locale) },
          { "@type": "ListItem", position: 2, name: input.hubName, item: absoluteSiteUrl("/genres", locale) },
          { "@type": "ListItem", position: 3, name: input.name, item: input.genreUrl },
        ],
      },
    ],
  };
}
