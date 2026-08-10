import { Inter } from "next/font/google";
import { Providers } from "./providers";
import AppShell from "@/components/AppShell";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata = {
  title: "NewReal — роллплей ИИ на русском",
  description: "Создай персонажа из своих снов. Общайся без цензуры с продвинутыми ИИ-моделями.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ru" className={`${inter.variable} h-full`} data-theme="wetdreams">
      <body className={`${inter.className} h-full antialiased bg-wd-bg text-wd-text`}>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}