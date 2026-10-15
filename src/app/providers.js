"use client";

import { SessionProvider } from "next-auth/react";
import { useEffect } from "react";
import config from "@/lib/config";
import I18nProvider from "@/components/I18nProvider";
import { CurrencyProvider } from "@/components/CurrencyContext";
import { TelegramProvider } from "@/components/TelegramProvider";

export function Providers({ children, locale = "ru", telegram = false }) {
  useEffect(() => {
    if (typeof window !== "undefined") {
      const theme = config?.theme || "slate-indigo";
      document.documentElement.setAttribute("data-theme", theme);
    }
  }, []);

  return (
    <I18nProvider locale={locale}>
      <SessionProvider refetchInterval={5 * 60} refetchOnWindowFocus>
        <TelegramProvider enabled={telegram}>
          <CurrencyProvider>{children}</CurrencyProvider>
        </TelegramProvider>
      </SessionProvider>
    </I18nProvider>
  );
}
