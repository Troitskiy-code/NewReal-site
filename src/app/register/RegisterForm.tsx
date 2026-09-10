"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Trans, useTranslation } from "react-i18next";
import { METRIKA_GOALS, reachGoal } from "@/lib/metrika";
import {
  AUTH_BUTTON_CLASS,
  AUTH_INPUT_CLASS,
  AuthCard,
  GoogleAuthButton,
} from "@/components/AuthCard";
import LocaleLink, { useCurrentLocale } from "@/components/LocaleLink";
import { withLocale } from "@/lib/i18nConfig";
import { REGISTER_CONSENT_COOKIE } from "@/lib/consentCookie";

type RegisterFormProps = {
  googleAuthEnabled: boolean;
};

function ConsentLink({ href, children }: { href: string; children?: React.ReactNode }) {
  return (
    <LocaleLink
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold text-primary underline hover:text-primary-hover"
    >
      {children}
    </LocaleLink>
  );
}

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
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedOffer, setAcceptedOffer] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const markConsentCookie = () => {
    document.cookie = `${REGISTER_CONSENT_COOKIE}=1; Path=/; Max-Age=600; SameSite=Lax`;
  };

  const ensureConsent = () => {
    if (acceptedTerms && acceptedOffer) return true;
    setError(t("auth.consentRequired"));
    return false;
  };

  const handleGoogleRegister = () => {
    reachGoal(METRIKA_GOALS.register);
    setError("");
    if (!ensureConsent()) {
      return;
    }
    markConsentCookie();
    void signIn("google", { callbackUrl: withLocale("/", locale) });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    reachGoal(METRIKA_GOALS.register);
    setError("");
    setSuccess("");

    if (password !== confirmPassword) {
      setError(t("auth.passwordMismatch"));
      return;
    }

    if (!ensureConsent()) {
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
          acceptedTerms: true,
          acceptedOffer: true,
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
      <div className="space-y-3">
        <label className="flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-wd-text-secondary">
          <input
            type="checkbox"
            checked={acceptedTerms}
            onChange={(e) => {
              setAcceptedTerms(e.target.checked);
              setError("");
            }}
            className="mt-0.5 accent-[#6C63FF]"
          />
          <span>
            <Trans
              i18nKey="auth.consentTerms"
              components={{
                terms: <ConsentLink href="/terms" />,
                privacy: <ConsentLink href="/privacy" />,
              }}
            />
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-wd-text-secondary">
          <input
            type="checkbox"
            checked={acceptedOffer}
            onChange={(e) => {
              setAcceptedOffer(e.target.checked);
              setError("");
            }}
            className="mt-0.5 accent-[#6C63FF]"
          />
          <span>
            <Trans
              i18nKey="auth.consentOffer"
              components={{
                offer: <ConsentLink href="/offer" />,
              }}
            />
          </span>
        </label>
      </div>
      {googleAuthEnabled && (
        <div className="mt-6">
          <GoogleAuthButton onClick={handleGoogleRegister}>
            {t("auth.register_google")}
          </GoogleAuthButton>
        </div>
      )}
      {error && <p className="mt-4 text-sm text-primary">{error}</p>}
      {googleAuthEnabled && (
        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-divider" />
          <span className="text-xs text-wd-text-secondary">{t("auth.or")}</span>
          <div className="h-px flex-1 bg-divider" />
        </div>
      )}
      <form onSubmit={handleSubmit} className={googleAuthEnabled ? "space-y-4" : "mt-6 space-y-4"}>
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
