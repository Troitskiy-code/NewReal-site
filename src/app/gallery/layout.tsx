import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("gallery");
}

export default function GalleryLayout({ children }: { children: React.ReactNode }) {
  return children;
}
