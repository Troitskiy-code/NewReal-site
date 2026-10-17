import Footer from "@/components/Footer";
import LocaleLink from "@/components/LocaleLink";
import { FEATURED_GENRES } from "@/lib/characterTags";
import { getGenreStats } from "@/lib/genreCatalog";
import { genrePath } from "@/lib/genreSeo";
import { translate } from "@/lib/getDictionary";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { getLocalizedPageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return getLocalizedPageMetadata("genres");
}

export default async function GenresPage() {
  const [locale, stats] = await Promise.all([getRequestLocale(), getGenreStats()]);

  return (
    <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-10 pt-6 md:px-6">
        <h1 className="font-display text-2xl font-semibold leading-tight tracking-tight text-white md:text-3xl">
          {translate(locale, "genrePage.hubH1")}
        </h1>
        <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-wd-text/85">{translate(locale, "genrePage.hubIntro")}</p>
        <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {FEATURED_GENRES.map((genre) => (
            <li key={genre.id}>
              <LocaleLink href={genrePath(genre.id)}
                className="flex min-h-14 items-center justify-between gap-2 rounded-2xl border border-wd-border bg-wd-card px-4 py-3 text-sm font-semibold text-white transition-colors hover:border-wd-secondary">
                <span>{translate(locale, `home.genres.${genre.id}`)}</span>
                <span className="text-xs font-semibold text-wd-text-secondary">{stats[genre.id].count}</span>
              </LocaleLink>
            </li>
          ))}
        </ul>
      </main>
      <Footer />
    </div>
  );
}
