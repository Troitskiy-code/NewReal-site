import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Избранное — NewVerse",
  robots: { index: false, follow: true },
};

export default function FavoritesLayout({ children }: { children: ReactNode }) {
  return children;
}
