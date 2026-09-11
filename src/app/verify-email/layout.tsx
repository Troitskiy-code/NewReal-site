import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  const metadata = await getLocalizedPageMetadata("verifyEmail");
  return { ...metadata, robots: { index: false, follow: false } };
}

export default function VerifyEmailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
