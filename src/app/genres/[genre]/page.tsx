import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Footer from "@/components/Footer";
import JsonLd from "@/components/JsonLd";
import CharacterCard from "@/components/CharacterCard";
import LocaleLink from "@/components/LocaleLink";
import GenrePagination from "./GenrePagination";
import { FEATURED_GENRES, type FeaturedGenre } from "@/lib/characterTags";
import { pickLocalizedText } from "@/lib/characterFields";
import { getGenrePage } from "@/lib/genreCatalog";
import { GENRE_INTROS } from "@/lib/genreIntros";
import { findFeaturedGenre, genreIndexingMetadata, genrePageUrl, genrePath, GENRES_PATH, parseGenrePage } from "@/lib/genreSeo";
import { translate } from "@/lib/getDictionary";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { absoluteAssetUrl, buildGenreJsonLd } from "@/lib/jsonLd";
import { createPageMetadata, OG_IMAGE, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, SITE_URL } from "@/lib/seo";

type PageProps = {
  params: Promise<{ genre: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

/** Unknown genres and pages past the end are 404; an empty first page still renders (noindex). */
async function loadGenrePage({ params, searchParams }: PageProps) {
  const genre = findFeaturedGenre((await params).genre);
  if (!genre) notFound();
  const page = parseGenrePage((await searchParams).page);
  const [locale, data] = await Promise.all([getRequestLocale(), getGenrePage(genre, page)]);
  if (page > 1 && data.data.length === 0) notFound();
  return { genre, page, locale, data };
}

function genreText(locale: string, genre: FeaturedGenre) {
  return {
    h1: translate(locale, `genrePage.items.${genre.id}.h1`),
    description: translate(locale, `genrePage.items.${genre.id}.description`),
    label: translate(locale, `home.genres.${genre.id}`),
  };
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { genre, page, locale, data } = await loadGenrePage(props);
  const { h1, description } = genreText(locale, genre);
  const title = page > 1
    ? translate(locale, "meta.genre.titlePage", { h1, page })
    : translate(locale, "meta.genre.title", { h1 });
  const first = data.data[0];
  const image = first ? absoluteAssetUrl(first.imageUrl) : OG_IMAGE;
  const metadata = createPageMetadata(title, description, image);
  const indexing = genreIndexingMetadata(genre.id, locale, SITE_URL, { page, publicCount: data.publicCount });

  return {
    ...metadata,
    ...indexing,
    openGraph: {
      ...metadata.openGraph,
      images: [{ url: image, width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, alt: h1 }],
      type: "website",
      url: genrePageUrl(SITE_URL, genre.id, locale, page),
    },
  };
}

export default async function GenrePage(props: PageProps) {
  const { genre, page, locale, data } = await loadGenrePage(props);
  const { h1, description, label } = genreText(locale, genre);
  const characters = data.data;
  const offset = (page - 1) * data.meta.limit;

  return (
    <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
      <JsonLd data={buildGenreJsonLd({
        genreUrl: genrePageUrl(SITE_URL, genre.id, locale),
        pageUrl: genrePageUrl(SITE_URL, genre.id, locale, page),
        name: h1,
        description,
        hubName: translate(locale, "genrePage.hub"),
        offset,
        characters: characters.map((character) => ({
          slug: character.slug,
          name: pickLocalizedText(character.name, character.name_en, locale) ?? character.name,
        })),
      }, locale)} />
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 pb-8 pt-5 md:px-6">
        <nav aria-label={translate(locale, "genrePage.breadcrumbs")} className="text-[13px] text-wd-text-secondary">
          <ol className="flex flex-wrap items-center gap-1.5">
            <li><LocaleLink href="/" className="transition-colors hover:text-white">{translate(locale, "genrePage.home")}</LocaleLink></li>
            <li aria-hidden>/</li>
            <li><LocaleLink href={GENRES_PATH} className="transition-colors hover:text-white">{translate(locale, "genrePage.hub")}</LocaleLink></li>
            <li aria-hidden>/</li>
            <li aria-current="page" className="text-wd-text">{label}</li>
          </ol>
        </nav>

        <header className="max-w-3xl space-y-3">
          <h1 className="font-display text-2xl font-semibold leading-tight tracking-tight text-white md:text-3xl">{h1}</h1>
          {page === 1 && GENRE_INTROS[genre.id][locale].map((paragraph, index) => (
            <p key={index} className="text-[15px] leading-relaxed text-wd-text/85">{paragraph}</p>
          ))}
          {data.meta.total > 0 && (
            <p className="text-[13px] text-wd-text-secondary">
              {translate(locale, "genrePage.count", { count: data.meta.total })}
            </p>
          )}
        </header>

        {characters.length === 0 ? (
          <div className="rounded-wd border border-wd-border bg-wd-card p-8 text-center shadow-wd">
            <p className="mx-auto max-w-md text-sm text-wd-text-secondary">{translate(locale, "genrePage.empty")}</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <LocaleLink href="/" className="wd-button inline-flex px-5 py-2.5 text-xs">{translate(locale, "genrePage.toCatalog")}</LocaleLink>
              <LocaleLink href="/create" className="inline-flex items-center rounded-wd-pill border border-wd-border px-5 py-2.5 text-xs font-bold text-white transition-colors hover:border-wd-secondary">
                {translate(locale, "header.menu.create")}
              </LocaleLink>
            </div>
          </div>
        ) : (
          <>
            <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4 lg:grid-cols-4 xl:grid-cols-5 xl:gap-5">
              {characters.map((character) => <CharacterCard key={character.id} character={character} />)}
            </div>
            <GenrePagination basePath={genrePath(genre.id)} page={page} totalPages={data.meta.totalPages} />
          </>
        )}

        <section aria-labelledby="other-genres" className="border-t border-wd-border pt-5">
          <h2 id="other-genres" className="mb-3 font-display text-base font-semibold text-white">{translate(locale, "genrePage.otherGenres")}</h2>
          <ul className="flex flex-wrap gap-2">
            {FEATURED_GENRES.filter((item) => item.id !== genre.id).map((item) => (
              <li key={item.id}>
                <LocaleLink href={genrePath(item.id)}
                  className="inline-flex min-h-9 items-center rounded-full bg-wd-card px-3.5 text-[13px] font-semibold text-wd-text-secondary transition-colors hover:text-white">
                  {translate(locale, `home.genres.${item.id}`)}
                </LocaleLink>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <Footer />
    </div>
  );
}
