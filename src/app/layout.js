import { Inter } from "next/font/google";
import { Providers } from "./providers";
import AppShell from "@/components/AppShell";
import AppToaster from "@/components/AppToaster";
import YandexMetrika from "@/components/YandexMetrika";
import { getLocalizedPageMetadata, SITE_URL, THEME_COLOR } from "@/lib/seo";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { isTelegramContext } from "@/lib/telegram/context";
import { TELEGRAM_LAUNCH_SCRIPT } from "@/lib/telegram/launchScript";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "cyrillic"],
  display: "swap",
});

export const dynamic = "force-dynamic";

export const viewport = {
  themeColor: THEME_COLOR,
};

export async function generateMetadata() {
  const metadata = await getLocalizedPageMetadata("home", { inheritOnly: true });
  return {
    metadataBase: new URL(SITE_URL),
    referrer: "strict-origin",
    ...metadata,
  };
}

export default async function RootLayout({ children }) {
  const locale = await getRequestLocale();
  // Telegram Mini App context (server-decided). The regular site renders exactly as before.
  const telegram = await isTelegramContext();

  return (
    <html lang={locale} className={`${inter.variable} h-full`} data-theme="wetdreams" data-telegram={telegram ? "1" : undefined}>
      {telegram ? (
        <head>
          {/* Must run before Metrika and the app: removes #tgWebAppData from the address. */}
          <script id="nv-tg-launch" dangerouslySetInnerHTML={{ __html: TELEGRAM_LAUNCH_SCRIPT }} />
        </head>
      ) : null}
      <body className={`${inter.className} h-full antialiased bg-wd-bg text-wd-text`}>
        <YandexMetrika />
        <Providers locale={locale} telegram={telegram}>
          <AppToaster />
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
