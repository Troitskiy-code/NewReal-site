import { Inter } from "next/font/google";
import { Providers } from "./providers";
import AppShell from "@/components/AppShell";
import YandexMetrika from "@/components/YandexMetrika";
import { PAGE_METADATA, SITE_URL } from "@/lib/seo";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata = {
  metadataBase: new URL(SITE_URL),
  ...PAGE_METADATA.home,
};

export default function RootLayout({ children }) {
  return (
    <html lang="ru" className={`${inter.variable} h-full`} data-theme="wetdreams">
      <body className={`${inter.className} h-full antialiased bg-wd-bg text-wd-text`}>
        <YandexMetrika />
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}