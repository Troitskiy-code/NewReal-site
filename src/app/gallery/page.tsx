import { getLocalizedPageMetadata } from "@/lib/seo";
import type { SeoSearchParams } from "@/lib/seoIndexing";
import GalleryPageClient from "./GalleryPageClient";

export async function generateMetadata({ searchParams }: { searchParams: Promise<SeoSearchParams> }) {
  return getLocalizedPageMetadata("gallery", { searchParams: await searchParams });
}

export default function GalleryPage() {
  return <GalleryPageClient />;
}
