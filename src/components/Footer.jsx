"use client";

import LocaleLink from "./LocaleLink";
import Logo from "./Logo";
import LanguageSwitcher from "./LanguageSwitcher";
import { useTranslation } from "react-i18next";

export default function Footer() {
  const { t } = useTranslation();

  return (
    <footer className="border-t border-wd-border bg-wd-bg px-4 py-6 text-center">
      <Logo size="md" className="mb-2 inline-block" />
      <nav className="mb-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
        <LocaleLink href="/offer" className="text-wd-text-secondary transition-colors hover:text-white">
          {t("footer.offer")}
        </LocaleLink>
        <LocaleLink href="/terms" className="text-wd-text-secondary transition-colors hover:text-white">
          {t("footer.terms")}
        </LocaleLink>
        <LocaleLink href="/refund" className="text-wd-text-secondary transition-colors hover:text-white">
          {t("footer.refund")}
        </LocaleLink>
        <LocaleLink href="/support" className="text-wd-text-secondary transition-colors hover:text-white">
          {t("footer.support")}
        </LocaleLink>
      </nav>
      <LanguageSwitcher className="mb-3" />
      <p className="text-xs text-wd-text-secondary">
        {t("footer.copyright", { year: new Date().getFullYear() })}
      </p>
    </footer>
  );
}
