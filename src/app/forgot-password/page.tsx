"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AUTH_BUTTON_CLASS,
  AUTH_INPUT_CLASS,
  AuthCard,
} from "@/components/AuthCard";

export default function ForgotPasswordPage() {
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error || "Не удалось отправить ссылку");
        return;
      }

      setSent(true);
    } catch (err) {
      console.error("[ForgotPassword] Request failed:", err);
      setError("Произошла ошибка соединения с сервером");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard title="Восстановление пароля">
      {sent ? (
        <p className="text-sm text-wd-secondary">
          Ссылка для сброса пароля отправлена на вашу почту
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            placeholder="Электронная почта"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={AUTH_INPUT_CLASS}
          />
          <button type="submit" disabled={loading} className={AUTH_BUTTON_CLASS}>
            {loading ? "Отправка..." : "Отправить ссылку"}
          </button>
        </form>
      )}
      {error && <p className="mt-4 text-sm text-primary">{error}</p>}
      <p className="mt-6 text-center text-sm text-wd-text-secondary">
        Вспомнили пароль?{" "}
        <Link href="/login" className="font-semibold text-primary transition hover:text-primary-hover">
          Войти
        </Link>
      </p>
    </AuthCard>
  );
}
