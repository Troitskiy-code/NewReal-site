"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";
import { useLocalizedPathname } from "./LocaleLink";

export default function EmailVerificationBanner() {
  const { data: session, status, update } = useSession();
  const { t, i18n } = useTranslation();
  const pathname = useLocalizedPathname();
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const isVerified = Boolean(session?.user?.emailVerified);

  if (status !== "authenticated" || isVerified) {
    return null;
  }

  if (pathname.startsWith("/verify-email") || pathname === "/login" || pathname === "/register") {
    return null;
  }

  const handleResend = async () => {
    setSending(true);
    setMessage("");
    setError("");
    try {
      const res = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-locale": i18n.language },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error || t("auth.resendError"));
        return;
      }
      setMessage(t("auth.resendSuccess"));
    } catch (err) {
      console.error("[EmailVerification] Banner resend failed:", err);
      setError(t("auth.resendError"));
    } finally {
      setSending(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setMessage("");
    setError("");
    try {
      await update();
    } catch (err) {
      console.error("[EmailVerification] Banner session refresh failed:", err);
      setError(t("auth.refreshStatusError"));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="fixed left-0 right-0 top-14 z-[55] border-b border-[#2A2A2A] bg-[#1A1A1A] px-4 py-2 md:top-20">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-center gap-2 text-center sm:flex-row sm:gap-4">
        <p className="text-sm text-wd-text">{t("auth.verifyBanner")}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={handleResend}
            disabled={sending || refreshing}
            className="shrink-0 rounded-wd-pill bg-primary px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-primary-hover disabled:opacity-50"
          >
            {sending ? t("auth.sending") : t("auth.resendEmail")}
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={sending || refreshing}
            className="shrink-0 rounded-wd-pill border border-wd-secondary/40 bg-transparent px-4 py-1.5 text-sm font-semibold text-white transition hover:border-wd-secondary disabled:opacity-50"
          >
            {refreshing ? t("auth.loading") : t("auth.refreshStatus")}
          </button>
        </div>
      </div>
      {message && <p className="mt-1 text-center text-xs text-emerald-400">{message}</p>}
      {error && <p className="mt-1 text-center text-xs text-primary">{error}</p>}
    </div>
  );
}
