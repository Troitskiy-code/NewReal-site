import { PAGE_METADATA } from "@/lib/seo";

export const metadata = PAGE_METADATA.create;

export default function CreateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
