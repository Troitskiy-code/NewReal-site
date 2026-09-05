import { Inter } from "next/font/google";
import { Providers } from "./providers";
import AppShell from "@/components/AppShell";
import YandexMetrika from "@/components/YandexMetrika";
import { getLocalizedPageMetadata, SITE_URL } from "@/lib/seo";
import { getRequestLocale } from "@/lib/getRequestLocale";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export async function generateMetadata() {
  const metadata = await getLocalizedPageMetadata("home");
  return {
    metadataBase: new URL(SITE_URL),
    ...metadata,
  };
}

export default async function RootLayout({ children }) {
  const locale = await getRequestLocale();

  return (
    <html lang={locale} className={`${inter.variable} h-full`} data-theme="wetdreams">
      <body className={`${inter.className} h-full antialiased bg-wd-bg text-wd-text`}>
        <YandexMetrika />
        <Providers locale={locale}>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
