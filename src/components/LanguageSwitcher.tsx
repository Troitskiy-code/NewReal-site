"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";
import { LuCheck, LuChevronDown, LuGlobe, LuMonitor, LuSearch, LuX } from "react-icons/lu";
import {
  LOCALE_AUTO_COOKIE, LOCALES, LOCALE_COOKIE, localeDefinition, negotiateLocale,
  resolveLocale, stripLocalePrefix, withLocale, type Locale,
} from "@/lib/i18nConfig";

function languageName(locale: Locale, displayLocale: Locale): string {
  try {
    return new Intl.DisplayNames([localeDefinition(displayLocale).intl], { type: "language" }).of(locale)
      || localeDefinition(locale).label;
  } catch {
    return localeDefinition(locale).label;
  }
}

function savedAutomaticChoice(): boolean {
  const cookies = document.cookie.split(";").map(part => part.trim());
  const preference = cookies
    .find(part => part.startsWith(`${LOCALE_COOKIE}=`))?.slice(LOCALE_COOKIE.length + 1);
  return cookies.includes(`${LOCALE_AUTO_COOKIE}=1`) || !LOCALES.includes(preference as Locale);
}

const searchText = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

type LanguageMenuProps = {
  id: string;
  anchor: HTMLButtonElement;
  current: Locale;
  automatic: boolean;
  browserLocale: Locale;
  onClose: () => void;
  onChoose: (locale: Locale, automatic: boolean) => void;
};

function LanguageMenu({ id, anchor, current, automatic, browserLocale, onClose, onChoose }: LanguageMenuProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const normalizedQuery = searchText(query.trim());
  const options = LOCALES.map(locale => ({ locale, nativeName: localeDefinition(locale).label, translatedName: languageName(locale, current) }))
    .filter(({ locale, nativeName, translatedName }) =>
      [locale, nativeName, translatedName, localeDefinition(locale).languageName].some(value => searchText(value).includes(normalizedQuery)));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    function position() {
      if (!dialog || !window.matchMedia("(min-width: 768px)").matches) return;
      const rect = anchor.getBoundingClientRect();
      const width = dialog.getBoundingClientRect().width;
      const below = window.innerHeight - rect.bottom - 20;
      const above = rect.top - 20;
      const belowAnchor = below >= Math.min(dialog.scrollHeight, 520) || below >= above;
      const height = Math.max(80, belowAnchor ? below : above);
      dialog.style.setProperty("--language-height", `${height}px`);
      dialog.style.setProperty("--language-left", `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`);
      dialog.style.setProperty("--language-top", `${Math.max(12, belowAnchor ? rect.bottom + 8 : rect.top - 8 - Math.min(dialog.scrollHeight, height))}px`);
    }
    position();
    window.addEventListener("resize", position);
    // Avoid opening the virtual keyboard as the mobile sheet appears.
    if (window.matchMedia("(min-width: 768px)").matches) searchRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("resize", position);
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (anchor.isConnected) anchor.focus({ preventScroll: true });
    };
  }, [anchor]);

  return (
    <dialog
      ref={dialogRef}
      id={id}
      aria-labelledby={`${id}-title`}
      className="nv-language-dialog border border-wd-border bg-wd-card text-wd-text"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onKeyDown={event => {
        // Search inputs otherwise consume the first Escape just to clear their value.
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      }}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation();
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
    >
      <div aria-hidden className="mx-auto mt-3 h-1 w-9 shrink-0 rounded-full bg-wd-text-secondary/40 md:hidden" />
      <div className="flex shrink-0 items-center gap-3 px-5 pb-3 pt-4">
        <h2 id={`${id}-title`} className="flex-1 text-base font-semibold">{t("language.title")}</h2>
        <button type="button" autoFocus onClick={onClose} aria-label={t("language.close")} className="grid min-h-11 min-w-11 place-items-center rounded-full text-wd-text-secondary hover:bg-white/5 hover:text-white md:min-h-8 md:min-w-8">
          <LuX size={18} aria-hidden />
        </button>
      </div>
      <label className="mx-4 mb-2 flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-wd-border bg-wd-bg px-3 text-wd-text-secondary focus-within:border-wd-secondary/70 focus-within:ring-2 focus-within:ring-wd-secondary/20">
        <LuSearch size={16} aria-hidden className="shrink-0" />
        <input ref={searchRef} type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={t("language.search")} placeholder={t("language.search")} autoComplete="off" className="min-w-0 flex-1 bg-transparent py-2 text-base text-wd-text outline-none placeholder:text-wd-text-secondary md:text-sm" />
      </label>
      <button type="button" onClick={() => onChoose(browserLocale, true)} aria-pressed={automatic} className="mx-2 flex min-h-16 shrink-0 items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-white/5">
        <LuMonitor size={18} aria-hidden className="shrink-0 text-wd-text-secondary" />
        <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{t("language.automatic")}</span><span className="mt-0.5 block text-xs text-wd-text-secondary">{t("language.browserLanguage", { language: languageName(browserLocale, current) })}</span></span>
        {automatic && <LuCheck size={17} aria-hidden className="shrink-0 text-wd-primary-soft" />}
      </button>
      <div aria-hidden className="mx-4 my-1 h-px shrink-0 bg-wd-border" />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 pt-1" aria-label={t("language.label")}>
        <ul className="space-y-0.5">
          {options.map(({ locale, nativeName, translatedName }) => {
            const selected = !automatic && current === locale;
            const secondaryName = translatedName.toLocaleLowerCase() === nativeName.toLocaleLowerCase()
              ? localeDefinition(locale).languageName : translatedName;
            return <li key={locale}>
              <button type="button" onClick={() => onChoose(locale, false)} aria-pressed={selected} className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${selected ? "bg-wd-primary/10" : "hover:bg-white/5"}`}>
                <bdi lang={locale} className="min-w-0 flex-1 font-medium">{nativeName}</bdi>
                <span className="max-w-[45%] text-right text-xs text-wd-text-secondary">{secondaryName === nativeName ? locale.toUpperCase() : secondaryName}</span>
                <span className="grid w-4 shrink-0 place-items-center">{selected && <LuCheck size={17} aria-hidden className="text-wd-primary-soft" />}</span>
              </button>
            </li>;
          })}
        </ul>
        {options.length === 0 && <p role="status" className="px-3 py-5 text-sm text-wd-text-secondary">{t("language.empty")}</p>}
      </div>
      <p className="nv-language-foot shrink-0 border-t border-wd-border px-5 pt-3 text-xs text-wd-text-secondary">{t("language.saved")}</p>
    </dialog>
  );
}

export default function LanguageSwitcher({ className = "", variant = "header" }: { className?: string; variant?: "header" | "menu" }) {
  const pathname = usePathname();
  const { i18n, t } = useTranslation();
  const current = resolveLocale(i18n.language);
  const id = useId();
  const [menu, setMenu] = useState<{ anchor: HTMLButtonElement; automatic: boolean; browserLocale: Locale } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const isMenu = variant === "menu";

  const choose = (locale: Locale, automatic: boolean) => {
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
    document.cookie = `${LOCALE_AUTO_COOKIE}=${automatic ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
    close();
    if (locale === current) return;
    const path = window.location.pathname || pathname;
    window.location.assign(withLocale(stripLocalePrefix(path), locale) + window.location.search + window.location.hash);
  };

  return (
    <>
      <button
        type="button"
        aria-label={`${t("language.choose")}: ${localeDefinition(current).label}`}
        aria-haspopup="dialog"
        aria-expanded={menu !== null}
        aria-controls={menu ? id : undefined}
        onClick={event => setMenu({ anchor: event.currentTarget, automatic: savedAutomaticChoice(), browserLocale: negotiateLocale(navigator.languages?.join(",") || navigator.language) })}
        className={`nv-language-trigger inline-flex min-h-10 items-center gap-2 border border-wd-border bg-wd-card text-sm text-wd-text transition-colors hover:bg-wd-elevated ${isMenu ? "w-full justify-between rounded-xl px-3 py-2" : "rounded-full px-3"} ${className}`}
      >
        <LuGlobe size={16} aria-hidden className="shrink-0 text-wd-text-secondary" />
        <span className={isMenu ? "flex-1 text-left" : "font-semibold uppercase"}>{isMenu ? localeDefinition(current).label : current}</span>
        <LuChevronDown size={14} aria-hidden className="shrink-0 text-wd-text-secondary" />
      </button>
      {menu && createPortal(<LanguageMenu id={id} anchor={menu.anchor} current={current} automatic={menu.automatic} browserLocale={menu.browserLocale} onClose={close} onChoose={choose} />, document.body)}
    </>
  );
}
