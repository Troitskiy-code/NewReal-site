import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("profile");
}

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
