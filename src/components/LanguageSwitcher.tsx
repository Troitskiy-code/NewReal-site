"use client";

import { usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";
import { LOCALES, LOCALE_COOKIE, stripLocalePrefix, withLocale, type Locale } from "@/lib/i18nConfig";

function persistLocale(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

export default function LanguageSwitcher({ className = "" }: { className?: string }) {
  const pathname = usePathname();
  const { i18n, t } = useTranslation();
  const current = (LOCALES.includes(i18n.language as Locale) ? i18n.language : "ru") as Locale;

  const switchLocale = (locale: Locale) => {
    if (locale === current) return;
    persistLocale(locale);
    void i18n.changeLanguage(locale);
    const path = typeof window !== "undefined" ? window.location.pathname : pathname;
    window.location.assign(withLocale(stripLocalePrefix(path), locale));
  };

  return (
    <div className={`inline-flex items-center gap-1 ${className}`} aria-label={t("language.label")}>
      {LOCALES.map((locale) => (
        <button
          key={locale}
          type="button"
          onClick={() => switchLocale(locale)}
          className={`rounded px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide transition-colors ${
            current === locale
              ? "bg-white/10 text-white"
              : "text-[#A0A0A0] hover:text-white"
          }`}
        >
          {t(`language.${locale}`)}
        </button>
      ))}
    </div>
  );
}
