import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("edit");
}

export default function EditLayout({ children }: { children: React.ReactNode }) {
  return children;
}
