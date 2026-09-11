"use client";

import { SessionProvider } from "next-auth/react";
import { useEffect } from "react";
import config from "@/lib/config";
import I18nProvider from "@/components/I18nProvider";
import { CurrencyProvider } from "@/components/CurrencyContext";

export function Providers({ children, locale = "ru" }) {
  useEffect(() => {
    if (typeof window !== "undefined") {
      const theme = config?.theme || "slate-indigo";
      document.documentElement.setAttribute("data-theme", theme);
    }
  }, []);

  return (
    <I18nProvider locale={locale}>
      <SessionProvider refetchInterval={5 * 60} refetchOnWindowFocus>
        <CurrencyProvider>{children}</CurrencyProvider>
      </SessionProvider>
    </I18nProvider>
  );
}
