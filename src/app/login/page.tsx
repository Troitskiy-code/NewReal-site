"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { METRIKA_GOALS, reachGoal } from "@/lib/metrika";
import { AUTH_BUTTON_CLASS, AUTH_INPUT_CLASS, AuthCard } from "@/components/AuthCard";

export default function LoginPage() {
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

  return (
    <AuthCard title="Вход">
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
