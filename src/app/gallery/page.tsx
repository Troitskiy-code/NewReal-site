import { getLocalizedPageMetadata } from "@/lib/seo";
import type { SeoSearchParams } from "@/lib/seoIndexing";
import GalleryPageClient from "./GalleryPageClient";
import { getPublicCatalog, parseCatalogQuery } from "@/lib/publicCatalog";

export async function generateMetadata({ searchParams }: { searchParams: Promise<SeoSearchParams> }) {
  return getLocalizedPageMetadata("gallery", { searchParams: await searchParams });
}

export default async function GalleryPage({ searchParams }: { searchParams: Promise<SeoSearchParams> }) {
  const query = parseCatalogQuery(await searchParams);
  const initialData = await getPublicCatalog(query.sort, query.page, query.search);
  return <GalleryPageClient key={`${query.sort}:${query.page}:${query.search}`} initialData={initialData} />;
}
