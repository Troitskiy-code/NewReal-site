"use client";

import { useTranslation } from "react-i18next";
import { loadTelegramSdk, openOutsideTelegram } from "./TelegramProvider";
import { useCurrentLocale } from "./LocaleLink";

export default function TelegramSignedOut() {
  const { t } = useTranslation();
  const locale = useCurrentLocale();
  return <main className="mx-auto flex min-h-[60dvh] max-w-md flex-col justify-center gap-4 px-4 py-10" data-testid="telegram-signed-out">
    <h1 className="text-xl font-black text-white">{t("telegram.signedOutTitle")}</h1>
    <p className="text-sm text-wd-text-secondary">{t("telegram.signedOutText")}</p>
    <button type="button" className="wd-button py-3" onClick={() => { void loadTelegramSdk().then((app) => app?.close?.()); }}>{t("telegram.closeApp")}</button>
    <button type="button" className="text-sm text-wd-secondary-text underline" onClick={() => openOutsideTelegram(`/${locale}/login`)}>{t("telegram.webLogin")}</button>
  </main>;
}
