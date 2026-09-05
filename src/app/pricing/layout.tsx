import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("pricing");
}

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
