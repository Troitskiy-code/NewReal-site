"use client";

import { usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";
import { LOCALES, LOCALE_COOKIE, localeDefinition, resolveLocale, stripLocalePrefix, withLocale, type Locale } from "@/lib/i18nConfig";

function persistLocale(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

export default function LanguageSwitcher({
  className = "",
  variant = "header",
}: {
  className?: string;
  variant?: "header" | "menu";
}) {
  const pathname = usePathname();
  const { i18n, t } = useTranslation();
  const current = resolveLocale(i18n.language);
  const isMenu = variant === "menu";

  const switchLocale = (locale: Locale) => {
    if (locale === current) return;
    persistLocale(locale);
    void i18n.changeLanguage(locale);
    const path = typeof window !== "undefined" ? window.location.pathname : pathname;
    window.location.assign(withLocale(stripLocalePrefix(path), locale) + window.location.search + window.location.hash);
  };

  if (LOCALES.length > 3) return (
    <select
      aria-label={t("language.label")}
      value={current}
      onChange={(event) => switchLocale(event.target.value as Locale)}
      className={`min-h-10 rounded-xl border border-wd-border bg-wd-card px-3 text-sm text-white ${isMenu ? "w-full" : "max-w-40"} ${className}`}
    >
      {LOCALES.map((locale) => <option key={locale} value={locale}>{localeDefinition(locale).label}</option>)}
    </select>
  );

  return (
    <div
      className={`${isMenu ? "flex w-full" : "inline-flex"} flex-wrap items-center gap-0.5 rounded-2xl border border-wd-border bg-wd-card p-1 ${className}`}
      aria-label={t("language.label")}
    >
      {LOCALES.map((locale) => (
        <button
          key={locale}
          type="button"
          onClick={() => switchLocale(locale)}
          aria-pressed={current === locale}
          className={`min-h-8 rounded-full px-3 text-xs font-bold uppercase tracking-wide transition-colors ${
            isMenu ? "min-h-10 flex-1" : ""
          } ${
            current === locale
              ? "bg-white/12 text-white"
              : "text-wd-text-secondary hover:text-white"
          }`}
        >
          {localeDefinition(locale).label}
        </button>
      ))}
    </div>
  );
}
