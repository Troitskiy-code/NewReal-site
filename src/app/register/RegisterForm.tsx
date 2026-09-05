"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslation } from "react-i18next";
import { METRIKA_GOALS, reachGoal } from "@/lib/metrika";
import {
  AUTH_BUTTON_CLASS,
  AUTH_INPUT_CLASS,
  AuthCard,
  GoogleAuthButton,
} from "@/components/AuthCard";
import LocaleLink, { useCurrentLocale } from "@/components/LocaleLink";
import { withLocale } from "@/lib/i18nConfig";

type RegisterFormProps = {
  googleAuthEnabled: boolean;
};

export default function RegisterForm({ googleAuthEnabled }: RegisterFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, i18n } = useTranslation();
  const locale = useCurrentLocale();
  const ref = searchParams.get("ref");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    reachGoal(METRIKA_GOALS.register);
    setError("");
    setSuccess("");

    if (password !== confirmPassword) {
      setError(t("auth.passwordMismatch"));
      return;
    }

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-locale": i18n.language },
        body: JSON.stringify({
          name,
          email,
          password,
          ...(ref ? { ref } : {}),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || t("auth.registerError"));
      } else {
        setSuccess(t("auth.registerSuccess"));
        setTimeout(() => router.push(withLocale("/login", locale)), 2000);
      }
    } catch (err) {
      console.error("Register request failed:", err);
      setError(t("auth.connectionError"));
    }
  };

  return (
    <AuthCard title={t("auth.registerTitle")}>
      {googleAuthEnabled && (
        <>
          <GoogleAuthButton onClick={() => reachGoal(METRIKA_GOALS.register)}>
            {t("auth.register_google")}
          </GoogleAuthButton>
          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-divider" />
            <span className="text-xs text-wd-text-secondary">{t("auth.or")}</span>
            <div className="h-px flex-1 bg-divider" />
          </div>
        </>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="text"
          placeholder={t("auth.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className={AUTH_INPUT_CLASS}
        />
        <input
          type="email"
          placeholder={t("auth.emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className={AUTH_INPUT_CLASS}
        />
        <input
          type="password"
          placeholder={t("auth.password")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className={AUTH_INPUT_CLASS}
        />
        <input
          type="password"
          placeholder={t("auth.confirmPassword")}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          className={AUTH_INPUT_CLASS}
        />
        <button type="submit" id="register-submit" data-metrika="register" className={AUTH_BUTTON_CLASS}>
          {t("auth.register")}
        </button>
      </form>
      {error && <p className="mt-4 text-sm text-primary">{error}</p>}
      {success && <p className="mt-4 text-sm text-wd-secondary">{success}</p>}
      <p className="mt-6 text-center text-sm text-wd-text-secondary">
        {t("auth.hasAccount")}{" "}
        <LocaleLink href="/login" className="font-semibold text-primary transition hover:text-primary-hover">
          {t("auth.login")}
        </LocaleLink>
      </p>
    </AuthCard>
  );
}
