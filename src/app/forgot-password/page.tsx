"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AUTH_BUTTON_CLASS,
  AUTH_INPUT_CLASS,
  AuthCard,
} from "@/components/AuthCard";
import LocaleLink from "@/components/LocaleLink";

export default function ForgotPasswordPage() {
  const { t, i18n } = useTranslation();
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-locale": i18n.language },
        body: JSON.stringify({ email, locale: i18n.language }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error || t("auth.sendLinkError"));
        return;
      }

      setSent(true);
    } catch (err) {
      console.error("[ForgotPassword] Request failed:", err);
      setError(t("auth.connectionError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard title={t("auth.forgotTitle")}>
      {sent ? (
        <p className="text-sm text-wd-secondary">{t("auth.linkSent")}</p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            placeholder={t("auth.emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={AUTH_INPUT_CLASS}
          />
          <button type="submit" disabled={loading} className={AUTH_BUTTON_CLASS}>
            {loading ? t("auth.sending") : t("auth.sendLink")}
          </button>
        </form>
      )}
      {error && <p className="mt-4 text-sm text-primary">{error}</p>}
      <p className="mt-6 text-center text-sm text-wd-text-secondary">
        {t("auth.rememberedPassword")}{" "}
        <LocaleLink href="/login" className="font-semibold text-primary transition hover:text-primary-hover">
          {t("auth.login")}
        </LocaleLink>
      </p>
    </AuthCard>
  );
}
