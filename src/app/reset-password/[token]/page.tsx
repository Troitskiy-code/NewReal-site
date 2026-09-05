"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import {
  AUTH_BUTTON_CLASS,
  AUTH_INPUT_CLASS,
  AuthCard,
} from "@/components/AuthCard";
import LocaleLink, { useCurrentLocale } from "@/components/LocaleLink";
import { withLocale } from "@/lib/i18nConfig";

const MIN_PASSWORD_LENGTH = 8;

export default function ResetPasswordPage() {
  const router = useRouter();
  const params = useParams();
  const { t, i18n } = useTranslation();
  const locale = useCurrentLocale();
  const token = typeof params.token === "string" ? params.token : "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [tokenError, setTokenError] = useState("");
  const [checkingToken, setCheckingToken] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) {
      setTokenError(t("auth.invalidLink"));
      setCheckingToken(false);
      return;
    }

    let cancelled = false;

    const validateToken = async () => {
      try {
        const res = await fetch(`/api/auth/reset-password?token=${encodeURIComponent(token)}`);
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !data?.valid) {
          setTokenError(t("auth.invalidLink"));
        }
      } catch (err) {
        console.error("[ResetPassword] Token check failed:", err);
        if (!cancelled) {
          setTokenError(t("auth.invalidLink"));
        }
      } finally {
        if (!cancelled) setCheckingToken(false);
      }
    };

    validateToken();
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError(t("auth.passwordMismatch"));
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t("auth.minPassword", { count: MIN_PASSWORD_LENGTH }));
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-locale": i18n.language },
        body: JSON.stringify({ token, password }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const message = data?.error || t("auth.resetFailed");
        if (data?.code === "invalidLink" || /invalid|expired|недействительна|истекла/i.test(message)) {
          setTokenError(message);
        } else {
          setError(message);
        }
        return;
      }

      router.push(`${withLocale("/login", locale)}?reset=success`);
    } catch (err) {
      console.error("[ResetPassword] Request failed:", err);
      setError(t("auth.connectionError"));
    } finally {
      setLoading(false);
    }
  };

  if (checkingToken) {
    return (
      <AuthCard title={t("auth.resetTitle")}>
        <p className="text-center text-sm text-wd-text-secondary">{t("auth.checkingLink")}</p>
      </AuthCard>
    );
  }

  if (tokenError) {
    return (
      <AuthCard title={t("auth.resetTitle")}>
        <p className="text-sm text-primary">{tokenError}</p>
        <p className="mt-6 text-center text-sm text-wd-text-secondary">
          <LocaleLink href="/forgot-password" className="font-semibold text-primary transition hover:text-primary-hover">
            {t("auth.requestNewLink")}
          </LocaleLink>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("auth.resetTitle")}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="password"
          placeholder={t("auth.newPassword")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
          className={AUTH_INPUT_CLASS}
        />
        <input
          type="password"
          placeholder={t("auth.confirmNewPassword")}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
          className={AUTH_INPUT_CLASS}
        />
        <button type="submit" disabled={loading} className={AUTH_BUTTON_CLASS}>
          {loading ? t("auth.saving") : t("auth.resetPassword")}
        </button>
      </form>
      {error && <p className="mt-4 text-sm text-primary">{error}</p>}
      <p className="mt-6 text-center text-sm text-wd-text-secondary">
        <LocaleLink href="/login" className="font-semibold text-primary transition hover:text-primary-hover">
          {t("auth.backToLogin")}
        </LocaleLink>
      </p>
    </AuthCard>
  );
}
