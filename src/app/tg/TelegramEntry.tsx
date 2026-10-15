"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import LocaleLink from "@/components/LocaleLink";
import { loadTelegramSdk, openOutsideTelegram } from "@/components/TelegramProvider";
import { useCurrentLocale } from "@/components/LocaleLink";
import { isLocale } from "@/lib/i18nConfig";

type State = "loading" | "consent" | "login_disabled" | "outside" | "unavailable" | "error";
type AuthResponse = { status?: string; redirect?: string; locale?: string };

async function launchInitData(): Promise<string> {
  // Captured by the inline launch script before the URL fragment was removed.
  const captured = window.__nvTgLaunch?.initData;
  if (captured) return captured;
  const app = await loadTelegramSdk();
  return app?.initData ?? "";
}

function safeRedirect(value: unknown): string | null {
  return typeof value === "string" && /^\/(?:ru|en)(?:\/[A-Za-z0-9/_-]*)?$/.test(value) ? value : null;
}

export default function TelegramEntry() {
  const { t, i18n } = useTranslation();
  const initialLocale = useCurrentLocale();
  const locale = isLocale(i18n.language) ? i18n.language : initialLocale;
  const [state, setState] = useState<State>("loading");
  const [terms, setTerms] = useState(false);
  const [rules, setRules] = useState(false);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const signIn = useCallback(async (consent: boolean) => {
    const initData = await launchInitData();
    if (!initData) { setState("outside"); return; }
    try {
      const response = await fetch("/api/telegram/auth", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData, consent, referralCode: new URLSearchParams(window.location.search).get("ref") }),
      });
      const data: AuthResponse = await response.json().catch(() => ({}));
      const redirect = safeRedirect(data.redirect);
      if (data.status === "ok" && redirect) {
        // A full load: the server renders the Telegram context with the new session.
        window.location.replace(redirect);
        return;
      }
      if (data.status === "consent_required") {
        if (isLocale(data.locale)) {
          await i18n.changeLanguage(data.locale);
          document.documentElement.lang = data.locale;
        }
        setState("consent");
      }
      else if (data.status === "login_disabled") setState("login_disabled");
      else if (response.status === 404 || response.status === 503) setState("unavailable");
      else setState("error");
    } catch {
      setState("error");
    }
  }, [i18n]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void signIn(false);
  }, [signIn]);

  const accept = async () => {
    if (!terms || !rules || busy) return;
    setBusy(true);
    await signIn(true);
    setBusy(false);
  };

  const outside = (path: string) => (
    <button type="button" className="text-wd-secondary-text underline" onClick={() => openOutsideTelegram(`/${locale}${path}`)} />
  );

  return (
    <main data-testid="telegram-entry" data-state={state} className="mx-auto flex min-h-[60dvh] w-full max-w-md flex-col justify-center gap-5 px-4 py-10">
      {state === "loading" && (
        <p role="status" className="text-center text-sm text-wd-text-secondary">{t("telegram.signingIn")}</p>
      )}
      {state === "consent" && (
        <section className="wd-card space-y-4 p-5">
          <h1 className="text-xl font-black text-white">{t("telegram.welcomeTitle")}</h1>
          <p className="text-sm text-wd-text-secondary">{t("telegram.welcomeText")}</p>
          <button type="button" onClick={() => openOutsideTelegram(`/${locale}/profile`)} className="w-full rounded-xl border border-wd-border px-4 py-3 text-sm font-bold text-wd-secondary-text">
            {t("telegram.linkExistingAccount")}
          </button>
          <label className="flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-wd-text-secondary">
            <input type="checkbox" checked={terms} onChange={(event) => setTerms(event.target.checked)} className="mt-0.5" />
            <span>
              <Trans i18nKey="auth.consentTerms" components={{ terms: outside("/terms"), privacy: outside("/privacy") }} />
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-wd-text-secondary">
            <input type="checkbox" checked={rules} onChange={(event) => setRules(event.target.checked)} className="mt-0.5" />
            <span>
              <Trans i18nKey="auth.consentRules" components={{ rules: <LocaleLink href="/rules" className="text-wd-secondary-text underline" /> }} />
            </span>
          </label>
          <p className="text-xs text-wd-text-secondary">{t("telegram.adultNotice")}</p>
          <button type="button" onClick={accept} disabled={!terms || !rules || busy} className="wd-button w-full py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? t("telegram.signingIn") : t("telegram.continue")}
          </button>
        </section>
      )}
      {state === "login_disabled" && (
        <section className="wd-card space-y-3 p-5">
          <h1 className="text-xl font-black text-white">{t("telegram.loginDisabledTitle")}</h1>
          <p className="text-sm text-wd-text-secondary">{t("telegram.loginDisabledText")}</p>
        </section>
      )}
      {(state === "outside" || state === "unavailable" || state === "error") && (
        <section className="wd-card space-y-3 p-5">
          <h1 className="text-xl font-black text-white">
            {state === "outside" ? t("telegram.outsideTitle") : t("telegram.errorTitle")}
          </h1>
          <p className="text-sm text-wd-text-secondary">
            {state === "outside" ? t("telegram.outsideText") : state === "unavailable" ? t("telegram.unavailableAppText") : t("telegram.errorText")}
          </p>
          {state === "error" && (
            <button type="button" onClick={() => { setState("loading"); void signIn(false); }} className="wd-button px-5 py-2.5 text-sm">
              {t("common.retry")}
            </button>
          )}
          <LocaleLink href="/" className="block text-sm font-bold text-wd-secondary-text">{t("telegram.toCatalog")}</LocaleLink>
        </section>
      )}
    </main>
  );
}
