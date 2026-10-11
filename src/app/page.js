import JsonLd from "@/components/JsonLd";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { buildWebsiteJsonLd } from "@/lib/jsonLd";
import HomePageContent from "./HomePageContent";
import { getLocalizedPageMetadata } from "@/lib/seo";
import { getPublicCatalog, parseCatalogQuery } from "@/lib/publicCatalog";
import { getViewerId } from "@/lib/characterPublic";

export async function generateMetadata({ searchParams }) {
  return getLocalizedPageMetadata("home", { searchParams: await searchParams });
}

export default async function HomePage({ searchParams }) {
  const locale = await getRequestLocale();
  const query = parseCatalogQuery(await searchParams);
  const [initialData, viewerId] = await Promise.all([
    getPublicCatalog(query.sort, query.page, query.search),
    getViewerId(),
  ]);
  const showHero = !viewerId && query.page === 1 && !query.search;

  return (
    <>
      <JsonLd data={buildWebsiteJsonLd(locale)} />
      <HomePageContent
        key={`${query.sort}:${query.page}:${query.search}`}
        initialData={initialData}
        showHero={showHero}
      />
    </>
  );
}
