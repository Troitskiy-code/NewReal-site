"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { METRIKA_GOALS, reachGoal } from "@/lib/metrika";
import {
  AUTH_BUTTON_CLASS,
  AUTH_GOOGLE_BUTTON_CLASS,
  AUTH_INPUT_CLASS,
  AuthCard,
} from "@/components/AuthCard";

type LoginFormProps = {
  googleAuthEnabled: boolean;
};

export default function LoginForm({ googleAuthEnabled }: LoginFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

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
      setError("Неверный email или пароль");
    } else {
      router.push("/");
    }
  };

  const handleGoogleSignIn = () => {
    reachGoal(METRIKA_GOALS.login);
    signIn("google", { callbackUrl: "/" });
  };

  return (
    <AuthCard title="Вход">
      {googleAuthEnabled && (
        <>
          <button
            type="button"
            onClick={handleGoogleSignIn}
            className={AUTH_GOOGLE_BUTTON_CLASS}
          >
            <GoogleIcon />
            Войти через Google
          </button>
          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-divider" />
            <span className="text-xs text-wd-text-secondary">или</span>
            <div className="h-px flex-1 bg-divider" />
          </div>
        </>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="email"
          placeholder="Электронная почта"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className={AUTH_INPUT_CLASS}
        />
        <input
          type="password"
          placeholder="Пароль"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className={AUTH_INPUT_CLASS}
        />
        <button type="submit" id="login-submit" data-metrika="login" className={AUTH_BUTTON_CLASS}>
          Войти
        </button>
      </form>
      {error && <p className="mt-4 text-sm text-primary">{error}</p>}
      <p className="mt-6 text-center text-sm text-wd-text-secondary">
        Нет аккаунта?{" "}
        <Link href="/register" className="font-semibold text-primary transition hover:text-primary-hover">
          Зарегистрироваться
        </Link>
      </p>
      <p className="mt-3 text-center">
        <Link href="/support" className="text-sm font-normal text-wd-text-secondary/70 transition hover:text-wd-text-secondary">
          Забыли пароль?
        </Link>
      </p>
    </AuthCard>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}
