import type { Metadata } from "next";

// Mini App pages are never indexed and are not listed in the sitemap.
export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function TelegramLayout({ children }: { children: React.ReactNode }) {
  return children;
}
