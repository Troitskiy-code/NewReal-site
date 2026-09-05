import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("forgotPassword");
}

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
