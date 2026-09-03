"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { METRIKA_GOALS, reachGoal } from "@/lib/metrika";
import {
  AUTH_BUTTON_CLASS,
  AUTH_INPUT_CLASS,
  AuthCard,
  GoogleAuthButton,
} from "@/components/AuthCard";

type RegisterFormProps = {
  googleAuthEnabled: boolean;
};

export default function RegisterForm({ googleAuthEnabled }: RegisterFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
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
    console.log("✅ Форма отправлена (обработчик вызван)");
    setError("");
    setSuccess("");

    if (password !== confirmPassword) {
      console.log("❌ Пароли не совпадают");
      setError("Пароли не совпадают");
      return;
    }

    console.log("📦 Отправляем данные:", { name, email, password: "***" });

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          ...(ref ? { ref } : {}),
        }),
      });

      console.log("📡 Статус ответа:", res.status);

      const data = await res.json();
      console.log("📨 Ответ сервера:", data);

      if (!res.ok) {
        setError(data.error || "Ошибка регистрации");
      } else {
        setSuccess("Регистрация прошла успешно! Перенаправляем на вход...");
        console.log("✅ Регистрация успешна, перенаправление через 2 секунды");
        setTimeout(() => router.push("/login"), 2000);
      }
    } catch (err) {
      console.error("❌ Ошибка при отправке запроса:", err);
      setError("Произошла ошибка соединения с сервером. Проверьте консоль.");
    }
  };

  return (
    <AuthCard title="Регистрация">
      {googleAuthEnabled && (
        <>
          <GoogleAuthButton onClick={() => reachGoal(METRIKA_GOALS.register)}>
            Зарегистрироваться через Google
          </GoogleAuthButton>
          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-divider" />
            <span className="text-xs text-wd-text-secondary">или</span>
            <div className="h-px flex-1 bg-divider" />
          </div>
        </>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="text"
          placeholder="Имя"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className={AUTH_INPUT_CLASS}
        />
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
        <input
          type="password"
          placeholder="Подтверждение пароля"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          className={AUTH_INPUT_CLASS}
        />
        <button type="submit" id="register-submit" data-metrika="register" className={AUTH_BUTTON_CLASS}>
          Зарегистрироваться
        </button>
      </form>
      {error && <p className="mt-4 text-sm text-primary">{error}</p>}
      {success && <p className="mt-4 text-sm text-wd-secondary">{success}</p>}
      <p className="mt-6 text-center text-sm text-wd-text-secondary">
        Уже есть аккаунт?{" "}
        <Link href="/login" className="font-semibold text-primary transition hover:text-primary-hover">
          Войти
        </Link>
      </p>
    </AuthCard>
  );
}
