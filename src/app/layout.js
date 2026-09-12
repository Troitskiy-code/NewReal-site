import { Inter } from "next/font/google";
import { Providers } from "./providers";
import AppShell from "@/components/AppShell";
import AppToaster from "@/components/AppToaster";
import YandexMetrika from "@/components/YandexMetrika";
import { getLocalizedPageMetadata, SITE_URL, THEME_COLOR } from "@/lib/seo";
import { getRequestLocale } from "@/lib/getRequestLocale";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const dynamic = "force-dynamic";

export const viewport = {
  themeColor: THEME_COLOR,
};

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
          <AppToaster />
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
