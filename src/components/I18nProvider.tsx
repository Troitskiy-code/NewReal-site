"use client";

import { I18nextProvider } from "react-i18next";
import { useEffect } from "react";
import i18n from "@/lib/i18n";

type I18nProviderProps = {
  children: React.ReactNode;
  locale: string;
};

export default function I18nProvider({ children, locale }: I18nProviderProps) {
  if (i18n.isInitialized && i18n.language !== locale) {
    void i18n.changeLanguage(locale);
  }

  useEffect(() => {
    if (i18n.language !== locale) {
      void i18n.changeLanguage(locale);
    }
    document.documentElement.lang = locale;
  }, [locale]);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
