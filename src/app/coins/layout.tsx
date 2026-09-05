import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("coins");
}

export default function CoinsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
