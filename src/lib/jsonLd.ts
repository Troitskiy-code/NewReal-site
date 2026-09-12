import { dateLocale, withLocale, type Locale } from "@/lib/i18nConfig";
import { SITE_URL } from "@/lib/seo";

export function absoluteSiteUrl(pathname: string, locale: Locale): string {
  return `${SITE_URL}${withLocale(pathname, locale)}`;
}

export function absoluteAssetUrl(path: string | null | undefined): string {
  if (!path) return `${SITE_URL}/logo.png`;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (path.startsWith("/")) return `${SITE_URL}${path}`;
  return `${SITE_URL}/logo.png`;
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
  const galleryUrl = absoluteSiteUrl("/gallery", locale);
  const fallbackDescription =
    locale === "en"
      ? `Chat with ${character.name} on NewVerse`
      : `Чат с персонажем ${character.name} на NewVerse`;
  const description = character.description.trim() || fallbackDescription;
  const authorName =
    character.authorName?.trim() || (locale === "en" ? "Author" : "Автор");

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
            name: locale === "en" ? "Home" : "Главная",
            item: homeUrl,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: locale === "en" ? "Gallery" : "Галерея",
            item: galleryUrl,
          },
          {
            "@type": "ListItem",
            position: 3,
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
