"use client";

import LocaleLink from "./LocaleLink";
import Logo from "./Logo";
import LanguageSwitcher from "./LanguageSwitcher";
import { useTranslation } from "react-i18next";
import { openOutsideTelegram, useTelegramMode } from "./TelegramProvider";
import { useCurrentLocale } from "./LocaleLink";
import { PROJECT_UPDATES_URL } from "@/lib/community";

const LINK_CLASS = "text-wd-text-secondary transition-colors hover:text-white";

// Telegram Mini App: no offer or refund terms; documents with payment terms open in the browser.
function TelegramFooterLinks() {
  const { t } = useTranslation();
  const locale = useCurrentLocale();
  return (
    <>
      <LocaleLink href="/rules" className={LINK_CLASS}>{t("footer.rules")}</LocaleLink>
      <LocaleLink href="/support" className={LINK_CLASS}>{t("footer.support")}</LocaleLink>
      <button type="button" onClick={() => openOutsideTelegram(`/${locale}/terms`)} className={LINK_CLASS}>{t("footer.terms")}</button>
      <button type="button" onClick={() => openOutsideTelegram(`/${locale}/privacy`)} className={LINK_CLASS}>{t("footer.privacy")}</button>
    </>
  );
}

export default function Footer() {
  const { t } = useTranslation();
  const telegram = useTelegramMode();

  return (
    <footer className="border-t border-wd-border bg-wd-bg px-4 py-6 text-center">
      <Logo size="md" className="mb-2 inline-block" />
      <nav className="mb-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
        <a href={PROJECT_UPDATES_URL} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          {t("footer.updates")}
        </a>
        {telegram ? <TelegramFooterLinks /> : <>
        <LocaleLink href="/offer" className="text-wd-text-secondary transition-colors hover:text-white">
          {t("footer.offer")}
        </LocaleLink>
        <LocaleLink href="/terms" className="text-wd-text-secondary transition-colors hover:text-white">
          {t("footer.terms")}
        </LocaleLink>
        <LocaleLink href="/privacy" className="text-wd-text-secondary transition-colors hover:text-white">
          {t("footer.privacy")}
        </LocaleLink>
        <LocaleLink href="/refund" className="text-wd-text-secondary transition-colors hover:text-white">
          {t("footer.refund")}
        </LocaleLink>
        <LocaleLink href="/rules" className="text-wd-text-secondary transition-colors hover:text-white">
          {t("footer.rules")}
        </LocaleLink>
        <LocaleLink href="/support" className="text-wd-text-secondary transition-colors hover:text-white">
          {t("footer.support")}
        </LocaleLink>
        </>}
      </nav>
      <LanguageSwitcher className="mb-3" />
      <p className="text-xs text-wd-text-secondary">
        {t("footer.copyright", { year: new Date().getFullYear() })}
      </p>
    </footer>
  );
}
