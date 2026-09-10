import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("notifications");
}

export default function NotificationsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
