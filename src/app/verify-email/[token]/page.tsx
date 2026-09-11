"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";
import { AUTH_BUTTON_CLASS, AuthCard } from "@/components/AuthCard";
import LocaleLink, { useCurrentLocale } from "@/components/LocaleLink";
import { withLocale } from "@/lib/i18nConfig";

type VerifyState = "pending" | "success" | "error";

const verifiedTokens = new Set<string>();
const verifyRequests = new Map<string, Promise<boolean>>();

function verifyEmailToken(token: string, locale: string): Promise<boolean> {
  const existing = verifyRequests.get(token);
  if (existing) return existing;

  const request = fetch("/api/auth/verify-email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-locale": locale },
    body: JSON.stringify({ token }),
  })
    .then((res) => res.ok)
    .catch((error) => {
      console.error("[EmailVerification] Verify request failed:", error);
      verifyRequests.delete(token);
      return false;
    });

  verifyRequests.set(token, request);
  return request;
}

export default function VerifyEmailPage() {
  const params = useParams();
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const { status, update } = useSession();
  const locale = useCurrentLocale();
  const token = typeof params.token === "string" ? params.token : "";

  const [state, setState] = useState<VerifyState>(() => {
    if (!token) return "error";
    if (verifiedTokens.has(token)) return "success";
    return "pending";
  });
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState("");
  const [resendError, setResendError] = useState("");

  useEffect(() => {
    if (!token) {
      setState("error");
      return;
    }

    if (verifiedTokens.has(token)) {
      setState("success");
      return;
    }

    let cancelled = false;

    const verify = async () => {
      const ok = await verifyEmailToken(token, i18n.language);
      if (cancelled) return;
      if (!ok) {
        setState("error");
        return;
      }
      verifiedTokens.add(token);
      setState("success");
      await update().catch(() => undefined);
    };

    void verify();
    return () => {
      cancelled = true;
    };
  }, [token, i18n.language, update]);

  const handleResend = async () => {
    setResendMessage("");
    setResendError("");

    if (status !== "authenticated") {
      router.push(withLocale("/login", locale));
      return;
    }

    setResending(true);
    try {
      const res = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-locale": i18n.language },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setResendError(data?.error || t("auth.resendError"));
        return;
      }
      setResendMessage(t("auth.resendSuccess"));
    } catch (error) {
      console.error("[EmailVerification] Resend failed:", error);
      setResendError(t("auth.resendError"));
    } finally {
      setResending(false);
    }
  };

  if (state === "pending") {
    return (
      <AuthCard title={t("auth.verifyTitle")}>
        <p className="text-center text-sm text-wd-text-secondary">{t("auth.verifying")}</p>
      </AuthCard>
    );
  }

  if (state === "success") {
    return (
      <AuthCard title={t("auth.verifyTitle")}>
        <p className="text-sm text-wd-text-secondary">{t("auth.verifySuccess")}</p>
        <LocaleLink href="/profile" className={`${AUTH_BUTTON_CLASS} mt-6 inline-flex justify-center`}>
          {t("auth.goToProfile")}
        </LocaleLink>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("auth.verifyTitle")}>
      <p className="text-sm text-wd-text-secondary">{t("auth.verifyInvalid")}</p>
      <button type="button" onClick={handleResend} disabled={resending} className={`${AUTH_BUTTON_CLASS} mt-6`}>
        {resending ? t("auth.sending") : t("auth.resendEmail")}
      </button>
      {resendMessage && <p className="mt-4 text-sm text-emerald-400">{resendMessage}</p>}
      {resendError && <p className="mt-4 text-sm text-primary">{resendError}</p>}
    </AuthCard>
  );
}
