"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  AUTH_BUTTON_CLASS,
  AUTH_INPUT_CLASS,
  AuthCard,
} from "@/components/AuthCard";

const MIN_PASSWORD_LENGTH = 8;

export default function ResetPasswordPage() {
  const router = useRouter();
  const params = useParams();
  const token = typeof params.token === "string" ? params.token : "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [tokenError, setTokenError] = useState("");
  const [checkingToken, setCheckingToken] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) {
      setTokenError("Ссылка недействительна или истекла");
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
          setTokenError("Ссылка недействительна или истекла");
        }
      } catch (err) {
        console.error("[ResetPassword] Token check failed:", err);
        if (!cancelled) {
          setTokenError("Ссылка недействительна или истекла");
        }
      } finally {
        if (!cancelled) setCheckingToken(false);
      }
    };

    validateToken();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Пароли не совпадают");
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Пароль должен содержать минимум ${MIN_PASSWORD_LENGTH} символов`);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const message = data?.error || "Не удалось сбросить пароль";
        if (message.includes("недействительна") || message.includes("истекла")) {
          setTokenError(message);
        } else {
          setError(message);
        }
        return;
      }

      router.push("/login?reset=success");
    } catch (err) {
      console.error("[ResetPassword] Request failed:", err);
      setError("Произошла ошибка соединения с сервером");
    } finally {
      setLoading(false);
    }
  };

  if (checkingToken) {
    return (
      <AuthCard title="Сброс пароля">
        <p className="text-center text-sm text-wd-text-secondary">Проверяем ссылку...</p>
      </AuthCard>
    );
  }

  if (tokenError) {
    return (
      <AuthCard title="Сброс пароля">
        <p className="text-sm text-primary">{tokenError}</p>
        <p className="mt-6 text-center text-sm text-wd-text-secondary">
          <Link href="/forgot-password" className="font-semibold text-primary transition hover:text-primary-hover">
            Запросить новую ссылку
          </Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Сброс пароля">
      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="password"
          placeholder="Новый пароль"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
          className={AUTH_INPUT_CLASS}
        />
        <input
          type="password"
          placeholder="Подтвердите пароль"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
          className={AUTH_INPUT_CLASS}
        />
        <button type="submit" disabled={loading} className={AUTH_BUTTON_CLASS}>
          {loading ? "Сохранение..." : "Сбросить пароль"}
        </button>
      </form>
      {error && <p className="mt-4 text-sm text-primary">{error}</p>}
      <p className="mt-6 text-center text-sm text-wd-text-secondary">
        <Link href="/login" className="font-semibold text-primary transition hover:text-primary-hover">
          Вернуться ко входу
        </Link>
      </p>
    </AuthCard>
  );
}
