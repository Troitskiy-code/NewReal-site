import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("subscription");
}

export default function SubscriptionLayout({ children }: { children: React.ReactNode }) {
  return children;
}
