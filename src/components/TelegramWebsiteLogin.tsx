"use client";

import { useEffect, useRef, useState } from "react";
import { FaTelegramPlane } from "react-icons/fa";
import { useTranslation } from "react-i18next";
import { METRIKA_GOALS, reachGoal } from "@/lib/metrika";

type RequestState = { url: string; code: string; expiresAt: string };

export default function TelegramWebsiteLogin({ callbackUrl }: { callbackUrl: string }) {
  const { t } = useTranslation();
  const [request, setRequest] = useState<RequestState | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    if (!request) return;
    let active = true;
    let polling = false;
    const current = generation.current;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await fetch("/api/telegram/login", { cache: "no-store" });
        const data = await response.json();
        if (!active || current !== generation.current) return;
        if (!response.ok) return;
        if (data.status === "approved") setName(data.name);
        else if (data.status === "expired" || Date.now() > Date.parse(request.expiresAt)) {
          setRequest(null); setName(null); setError(t("telegram.webLoginExpired"));
        }
      } catch { /* The next poll retries a transient connection failure. */ }
      finally { polling = false; }
    };
    const timer = window.setInterval(() => void poll(), 3000);
    void poll();
    return () => { active = false; window.clearInterval(timer); };
  }, [request, t]);

  async function action(kind: "create" | "complete") {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/telegram/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: kind }) });
      const data = await response.json();
      if (!response.ok) throw new Error(t(data.error === "rate_limited" ? "telegram.linkRateLimited" : data.error === "already_signed_in" ? "telegram.webAlreadySignedIn" : "telegram.webLoginExpired"));
      if (kind === "create") {
        generation.current++; setRequest(data); setName(null);
        reachGoal(METRIKA_GOALS.loginAttempt);
      } else {
        reachGoal(METRIKA_GOALS.login);
        window.location.assign(callbackUrl);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("telegram.linkError")); }
    finally { setBusy(false); }
  }

  return <section data-testid="telegram-website-login" className="mb-6 space-y-3">
    {!request ? <button type="button" disabled={busy} onClick={() => void action("create")} className="flex w-full items-center justify-center gap-2 rounded-xl border border-wd-border px-4 py-3 text-sm font-bold text-white disabled:opacity-50">
      <FaTelegramPlane aria-hidden />{t("telegram.webLogin")}
    </button> : <div className="space-y-3 rounded-xl border border-wd-border p-4 text-sm">
      <p className="text-wd-text-secondary">{t("telegram.webLoginHint")}</p>
      <p>{t("telegram.webLoginCode")} <strong className="tracking-widest">{request.code}</strong></p>
      <a href={request.url} target="_blank" rel="noopener noreferrer" className="block font-bold text-wd-secondary-text underline">{t("telegram.webLoginOpenBot")}</a>
      {name && <>
        <p>{t("telegram.webLoginAccount", { name })}</p>
        <button type="button" disabled={busy} className="wd-button w-full py-3" onClick={() => void action("complete")}>{t("telegram.webLoginComplete")}</button>
      </>}
      <button type="button" className="text-wd-text-secondary underline" disabled={busy} onClick={async () => {
        generation.current++; setBusy(true);
        try { await fetch("/api/telegram/login", { method: "DELETE" }); }
        catch { setError(t("telegram.linkError")); }
        finally { setRequest(null); setName(null); setBusy(false); }
      }}>{t("common.cancel")}</button>
    </div>}
    {error && <p role="alert" className="text-sm text-primary-soft">{error}</p>}
  </section>;
}
