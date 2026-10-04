import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Диалоги — NewVerse",
  robots: { index: false, follow: true },
};

export default function ChatsLayout({ children }: { children: ReactNode }) {
  return children;
}
