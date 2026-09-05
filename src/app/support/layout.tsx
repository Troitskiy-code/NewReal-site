import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("support");
}

export default function SupportLayout({ children }: { children: React.ReactNode }) {
  return children;
}
