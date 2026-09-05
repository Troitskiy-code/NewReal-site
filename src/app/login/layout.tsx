import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("login");
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
