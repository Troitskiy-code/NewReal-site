"use client";

import "./globals.css";
import { getLocaleFromPath } from "@/lib/i18nConfig";
import { ERROR_PRIMARY_BUTTON, ERROR_SECONDARY_BUTTON } from "@/components/ErrorState";

// Inlined rather than read from common.json, which would ship both full dictionaries with this boundary.
// Keep in sync with errorPage.* in public/locales.
const TEXT = {
  ru: {
    errorTitle: "Что-то пошло не так",
    errorText: "Мы уже знаем о проблеме. Попробуйте ещё раз или вернитесь в каталог.",
    retry: "Попробовать снова",
    toCatalog: "В каталог",
    errorCode: "Код ошибки",
  },
  en: {
    errorTitle: "Something went wrong",
    errorText: "We already know about the problem. Try again or go back to the catalog.",
    retry: "Try again",
    toCatalog: "Go to catalog",
    errorCode: "Error code",
  },
};

// Replaces the root layout when it fails, so it cannot rely on providers, i18n context or the app shell.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const locale = (typeof window !== "undefined" && getLocaleFromPath(window.location.pathname)) || "ru";
  const t = TEXT[locale];

  return (
    <html lang={locale}>
      <body className="flex min-h-dvh flex-col items-center justify-center bg-wd-bg px-4 text-center font-sans text-wd-text antialiased">
        <title>{`${t.errorTitle} — NewVerse`}</title>
        <p aria-hidden className="font-display text-7xl font-bold leading-none tracking-tight text-white">
          500
        </p>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-white">{t.errorTitle}</h1>
        <p className="mt-3 max-w-md text-[15px] leading-relaxed text-wd-text-secondary">{t.errorText}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <button type="button" onClick={() => retry()} className={ERROR_PRIMARY_BUTTON}>
            {t.retry}
          </button>
          {/* A plain link: client navigation needs the root layout that just failed. */}
          <a href={`/${locale}`} className={ERROR_SECONDARY_BUTTON}>
            {t.toCatalog}
          </a>
        </div>
        {error.digest && <p className="mt-6 text-xs text-wd-text-secondary">{`${t.errorCode}: ${error.digest}`}</p>}
      </body>
    </html>
  );
}
