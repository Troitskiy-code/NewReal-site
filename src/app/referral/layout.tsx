import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("referral");
}

export default function ReferralLayout({ children }: { children: React.ReactNode }) {
  return children;
}
