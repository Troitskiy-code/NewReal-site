import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("register");
}

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return children;
}
