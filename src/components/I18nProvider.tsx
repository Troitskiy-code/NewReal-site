"use client";

import { I18nextProvider } from "react-i18next";
import { useEffect, useMemo } from "react";
import i18n from "@/lib/i18n";
import { localeDefinition } from "@/lib/i18nConfig";

type I18nProviderProps = {
  children: React.ReactNode;
  locale: string;
};

export default function I18nProvider({ children, locale }: I18nProviderProps) {
  // The module singleton must never switch language during SSR: simultaneous RU
  // and EN requests would render each other's translations. Share resources only.
  const instance = useMemo(() => i18n.cloneInstance({ lng: locale, initAsync: false }), [locale]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = localeDefinition(locale).direction;
  }, [locale]);

  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
