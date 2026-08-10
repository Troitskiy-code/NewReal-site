"use client";

import { Suspense } from "react";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function RegisterContent() {
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
    <div className="min-h-dvh bg-wd-bg text-wd-text">
      <div style={{ maxWidth: 400, margin: "50px auto", padding: 20 }}>
        <h1>Регистрация</h1>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="Имя"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            style={{ width: "100%", marginBottom: 10, padding: 8 }}
          />
          <input
            type="email"
            placeholder="Электронная почта"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ width: "100%", marginBottom: 10, padding: 8 }}
          />
          <input
            type="password"
            placeholder="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ width: "100%", marginBottom: 10, padding: 8 }}
          />
          <input
            type="password"
            placeholder="Подтверждение пароля"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            style={{ width: "100%", marginBottom: 10, padding: 8 }}
          />
          <button
            type="submit"
            style={{
              width: "100%",
              padding: 10,
              cursor: "pointer",
              backgroundColor: "#0070f3",
              color: "#fff",
              border: "none",
              borderRadius: 4,
            }}
          >
            Зарегистрироваться
          </button>
        </form>
        {error && <p style={{ color: "red", marginTop: 10 }}>{error}</p>}
        {success && <p style={{ color: "green", marginTop: 10 }}>{success}</p>}
        <p style={{ marginTop: 16 }}>
          Уже есть аккаунт? <Link href="/login">Войти</Link>
        </p>
      </div>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-wd-bg text-wd-text flex items-center justify-center">Загрузка...</div>}>
      <RegisterContent />
    </Suspense>
  );
}