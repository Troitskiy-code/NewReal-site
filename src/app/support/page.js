"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import Footer from "@/components/Footer";

const SUPPORT_EMAIL = "mrcheleng87@gmail.com";
const TOPIC_KEYS = ["payment", "technical", "refund", "other"];

export default function SupportPage() {
  const { t } = useTranslation();
  const [topic, setTopic] = useState("payment");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  const handleSubmit = (event) => {
    event.preventDefault();

    const topicLabel = t(`support.topics.${topic}`);
    const subject = `NewVerse: ${topicLabel}`;
    const body = `${t("support.userEmailPrefix")}${email}\n\n${message}`;
    const mailtoUrl = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    window.location.href = mailtoUrl;
  };

  return (
    <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <h1 className="mb-4 text-3xl font-black uppercase tracking-tight text-white">{t("support.title")}</h1>
        <p className="mb-10 text-sm leading-relaxed text-wd-text-secondary">{t("support.intro")}</p>

        <section className="rounded-wd border border-wd-border bg-wd-card p-6 shadow-wd">
          <h2 className="mb-6 text-lg font-bold text-white">{t("support.formTitle")}</h2>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label htmlFor="support-topic" className="block text-xs font-bold uppercase tracking-wider text-wd-text-secondary">
                {t("support.topic")}
              </label>
              <select
                id="support-topic"
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                className="w-full rounded-wd border border-wd-border bg-[#0A0A0A] px-4 py-3 text-sm text-white outline-none transition-colors focus:border-wd-secondary/60"
              >
                {TOPIC_KEYS.map((item) => (
                  <option key={item} value={item}>
                    {t(`support.topics.${item}`)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="support-email" className="block text-xs font-bold uppercase tracking-wider text-wd-text-secondary">
                {t("support.email")}
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
                {t("support.message")}
              </label>
              <textarea
                id="support-message"
                required
                rows={6}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={t("support.messagePlaceholder")}
                className="w-full resize-y rounded-wd border border-wd-border bg-[#0A0A0A] px-4 py-3 text-sm text-white outline-none transition-colors focus:border-wd-secondary/60"
              />
            </div>

            <button
              type="submit"
              className="wd-button w-full rounded-wd-pill py-3 text-sm font-bold transition-all active:scale-[0.98]"
            >
              {t("support.submit")}
            </button>
          </form>

          <p className="mt-4 text-xs text-wd-text-secondary">{t("support.mailtoHint")}</p>
        </section>
      </main>

      <Footer />
    </div>
  );
}
