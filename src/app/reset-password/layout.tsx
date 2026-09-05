import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("resetPassword");
}

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
