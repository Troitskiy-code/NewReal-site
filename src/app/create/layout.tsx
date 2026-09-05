import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("create");
}

export default function CreateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
