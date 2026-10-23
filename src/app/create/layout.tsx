import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  // Only the /create landing page is indexable; it sets its own canonical. The editor stays noindex.
  return getLocalizedPageMetadata("create", { inheritOnly: true });
}

export default function CreateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
