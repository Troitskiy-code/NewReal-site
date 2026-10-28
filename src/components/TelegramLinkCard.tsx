"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaTelegramPlane } from "react-icons/fa";
import { showError, showSuccess } from "@/lib/toast";
import { dateLocale } from "@/lib/i18nConfig";
import { useConfirm } from "@/components/useConfirm";
import { useTelegramMode, openOutsideTelegram } from "@/components/TelegramProvider";

// Profile on the website: link the account to Telegram with a one-time t.me link, or unlink it.
// Hidden while the Mini App is switched off (the API answers 404).
type Status = { enabled: boolean; linked: boolean; linkedAt: string | null; canUnlink: boolean };

async function fetchStatus(): Promise<Status | null> {
  const response = await fetch("/api/telegram/link", { cache: "no-store" }).catch(() => null);
  return response?.ok ? response.json() : null;
}

export default function TelegramLinkCard() {
  const { t, i18n } = useTranslation();
  const telegram = useTelegramMode();
  const [confirm, confirmModal] = useConfirm();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingUntil, setPendingUntil] = useState<number | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const poll = useRef<number | null>(null);

  const load = useCallback(async () => {
    const data = await fetchStatus();
    setStatus(data);
    return data;
  }, []);

  useEffect(() => {
    let active = true;
    void fetchStatus().then((data) => { if (active) setStatus(data); });
    return () => { active = false; };
  }, []);

  // While a link is open in Telegram, check every few seconds until it is used or expires.
  useEffect(() => {
    if (!pendingUntil) return;
    poll.current = window.setInterval(async () => {
      const data = await load();
      if (data?.linked) {
        setPendingUntil(null);
        setLinkUrl(null);
        showSuccess(t("telegram.linkDone"));
      } else if (Date.now() > pendingUntil) {
        setPendingUntil(null);
        setLinkUrl(null);
      }
    }, 4000);
    return () => { if (poll.current) window.clearInterval(poll.current); };
  }, [pendingUntil, load, t]);

  if (!status?.enabled) return null;
  if (telegram) return <section data-testid="telegram-account-card" className="wd-card space-y-3 p-4 md:p-6">
    <p className="text-xs font-bold uppercase tracking-widest text-wd-text-secondary">Telegram</p>
    <p className="text-sm text-white">{t("telegram.accountHint")}</p>
    <p className="text-sm text-wd-text-secondary">{t("telegram.manageAccountHint")}</p>
    <button type="button" onClick={() => openOutsideTelegram(`/${i18n.language}/profile`)} className="rounded-[50px] border border-wd-border px-5 py-2.5 text-xs font-bold text-white">{t("telegram.openWebsiteAccount")}</button>
  </section>;

  const link = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/telegram/link", { method: "POST", headers: { "Content-Type": "application/json" } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.url !== "string") throw new Error(data.error === "rate_limited" ? t("telegram.linkRateLimited") : t("telegram.linkError"));
      setLinkUrl(data.url);
      setPendingUntil(Date.parse(data.expiresAt) || Date.now() + 10 * 60 * 1000);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      showError(error instanceof Error ? error.message : t("telegram.linkError"));
    }
    setBusy(false);
  };

  const unlink = async () => {
    const ok = await confirm({ title: t("telegram.unlinkTitle"), description: t("telegram.unlinkText"), confirmLabel: t("telegram.unlink"), danger: true });
    if (!ok) return;
    setBusy(true);
    const response = await fetch("/api/telegram/link", { method: "DELETE" }).catch(() => null);
    if (response?.ok) { showSuccess(t("telegram.unlinkDone")); await load(); }
    else showError(t("telegram.linkError"));
    setBusy(false);
  };

  return (
    <section data-testid="telegram-link-card" className="wd-card flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between md:p-6">
      <div className="flex items-start gap-3">
        <FaTelegramPlane className="mt-1 shrink-0 text-wd-secondary-text" />
        <div className="space-y-1">
          <p className="text-xs font-bold uppercase tracking-widest text-wd-text-secondary">Telegram</p>
          {status.linked ? (
            <p className="text-sm text-white">
              {t("telegram.linkedSince", {
                date: status.linkedAt ? new Date(status.linkedAt).toLocaleDateString(dateLocale(i18n.language)) : "—",
              })}
            </p>
          ) : (
            <p className="text-sm text-wd-text-secondary">{t("telegram.linkHint")}</p>
          )}
          {status.linked && !status.canUnlink && <p className="text-xs text-wd-text-secondary">{t("telegram.onlyLoginMethod")}</p>}
          {linkUrl && (
            <p className="text-xs text-wd-text-secondary">
              {t("telegram.linkPending")}{" "}
              <a href={linkUrl} target="_blank" rel="noopener noreferrer" className="text-wd-secondary-text underline">{t("telegram.linkOpenAgain")}</a>
            </p>
          )}
        </div>
      </div>
      {status.linked ? (
        status.canUnlink && (
          <button type="button" onClick={unlink} disabled={busy} className="rounded-[50px] border border-wd-border px-5 py-2.5 text-xs font-bold text-white disabled:opacity-50">
            {t("telegram.unlink")}
          </button>
        )
      ) : (
        <button type="button" onClick={link} disabled={busy} className="wd-button px-5 py-2.5 text-xs disabled:opacity-50">
          {t("telegram.link")}
        </button>
      )}
      {confirmModal}
    </section>
  );
}
