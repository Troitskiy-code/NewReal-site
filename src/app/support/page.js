"use client";

import { useState } from "react";
import Footer from "@/components/Footer";

const SUPPORT_EMAIL = "mrcheleng87@gmail.com";

const TOPICS = [
  "Вопрос по оплате",
  "Техническая проблема",
  "Возврат средств",
  "Другое",
];

export default function SupportPage() {
  const [topic, setTopic] = useState(TOPICS[0]);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  const handleSubmit = (event) => {
    event.preventDefault();

    const subject = `NewVerse: ${topic}`;
    const body = `Email пользователя: ${email}\n\n${message}`;
    const mailtoUrl = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    window.location.href = mailtoUrl;
  };

  return (
    <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <h1 className="mb-4 text-3xl font-black uppercase tracking-tight text-white">Поддержка</h1>
        <p className="mb-10 text-sm leading-relaxed text-wd-text-secondary">
          По вопросам оплаты, техническим проблемам и возвратам используйте форму ниже. Мы ответим
          на указанный email в течение 10 рабочих дней.
        </p>

        <section className="rounded-wd border border-wd-border bg-wd-card p-6 shadow-wd">
          <h2 className="mb-6 text-lg font-bold text-white">Подать обращение</h2>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label htmlFor="support-topic" className="block text-xs font-bold uppercase tracking-wider text-wd-text-secondary">
                Тема обращения
              </label>
              <select
                id="support-topic"
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                className="w-full rounded-wd border border-wd-border bg-[#0A0A0A] px-4 py-3 text-sm text-white outline-none transition-colors focus:border-wd-secondary/60"
              >
                {TOPICS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="support-email" className="block text-xs font-bold uppercase tracking-wider text-wd-text-secondary">
                Ваш email
              </label>
              <input
                id="support-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="example@mail.com"
                className="w-full rounded-wd border border-wd-border bg-[#0A0A0A] px-4 py-3 text-sm text-white outline-none transition-colors focus:border-wd-secondary/60"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="support-message" className="block text-xs font-bold uppercase tracking-wider text-wd-text-secondary">
                Сообщение
              </label>
              <textarea
                id="support-message"
                required
                rows={6}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Опишите проблему или вопрос..."
                className="w-full resize-y rounded-wd border border-wd-border bg-[#0A0A0A] px-4 py-3 text-sm text-white outline-none transition-colors focus:border-wd-secondary/60"
              />
            </div>

            <button
              type="submit"
              className="wd-button w-full rounded-wd-pill py-3 text-sm font-bold transition-all active:scale-[0.98]"
            >
              Отправить
            </button>
          </form>

          <p className="mt-4 text-xs text-wd-text-secondary">
            При нажатии «Отправить» откроется почтовый клиент с предзаполненным письмом.
          </p>
        </section>
      </main>

      <Footer />
    </div>
  );
}
