import JsonLd from "@/components/JsonLd";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { buildWebsiteJsonLd } from "@/lib/jsonLd";
import HomePageContent from "./HomePageContent";
import { getLocalizedPageMetadata } from "@/lib/seo";
import { getPublicCatalog, parseCatalogQuery } from "@/lib/publicCatalog";

export async function generateMetadata({ searchParams }) {
  return getLocalizedPageMetadata("home", { searchParams: await searchParams });
}

export default async function HomePage({ searchParams }) {
  const locale = await getRequestLocale();
  const query = parseCatalogQuery(await searchParams);
  const initialData = await getPublicCatalog(query.sort, query.page, query.search);

  return (
    <>
      <JsonLd data={buildWebsiteJsonLd(locale)} />
      <HomePageContent key={`${query.sort}:${query.page}:${query.search}`} initialData={initialData} />
    </>
  );
}
