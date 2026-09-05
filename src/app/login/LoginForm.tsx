"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
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

type LoginFormProps = {
  googleAuthEnabled: boolean;
};

export default function LoginForm({ googleAuthEnabled }: LoginFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useTranslation();
  const locale = useCurrentLocale();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const passwordResetSuccess = searchParams.get("reset") === "success";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    reachGoal(METRIKA_GOALS.login);
    setError("");

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (result?.error) {
      setError(t("auth.invalidCredentials"));
    } else {
      router.push(withLocale("/", locale));
    }
  };

  const handleGoogleSignIn = () => {
    reachGoal(METRIKA_GOALS.login);
  };

  return (
    <AuthCard title={t("auth.loginTitle")}>
      {googleAuthEnabled && (
        <>
          <GoogleAuthButton onClick={handleGoogleSignIn}>
            {t("auth.login_google")}
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
        <button type="submit" id="login-submit" data-metrika="login" className={AUTH_BUTTON_CLASS}>
          {t("auth.login")}
        </button>
      </form>
      {error && <p className="mt-4 text-sm text-primary">{error}</p>}
      {passwordResetSuccess && (
        <p className="mt-4 text-sm text-wd-secondary">{t("auth.passwordChanged")}</p>
      )}
      <p className="mt-6 text-center text-sm text-wd-text-secondary">
        {t("auth.noAccount")}{" "}
        <LocaleLink href="/register" className="font-semibold text-primary transition hover:text-primary-hover">
          {t("auth.register")}
        </LocaleLink>
      </p>
      <p className="mt-3 text-center">
        <LocaleLink href="/forgot-password" className="text-sm font-normal text-wd-text-secondary/70 transition hover:text-wd-text-secondary">
          {t("auth.forgot_password")}
        </LocaleLink>
      </p>
    </AuthCard>
  );
}
