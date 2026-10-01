"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslation } from "react-i18next";
import Footer from "@/components/Footer";
import { METRIKA_GOALS, reachGoal } from "@/lib/metrika";

const TOPIC_KEYS = ["payment", "technical", "refund", "moderation", "other"];

function isTopicKey(value) {
  return TOPIC_KEYS.includes(value);
}

export default function SupportPage() {
  const { t, i18n } = useTranslation();
  const searchParams = useSearchParams();
  const requestedTopic = searchParams.get("topic");
  const [topic, setTopic] = useState(isTopicKey(requestedTopic) ? requestedTopic : "payment");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [error, setError] = useState("");
  const [clientKey, setClientKey] = useState(() => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, "");
    }
    return `sup${Date.now().toString(16)}`;
  });

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("nv-support-draft");
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (typeof draft.email === "string") setEmail(draft.email);
      if (typeof draft.message === "string") setMessage(draft.message);
      if (isTopicKey(draft.topic)) setTopic(draft.topic);
    } catch {
      /* ignore */
    }
  }, []);

  const persistDraft = (next) => {
    try {
      sessionStorage.setItem("nv-support-draft", JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    setSending(true);
    persistDraft({ topic, email, message });

    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-locale": i18n.language },
        body: JSON.stringify({ topic, email, message, clientKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || t("support.error"));
        return;
      }
      reachGoal(METRIKA_GOALS.supportSubmit);
      setSuccess(t("support.success"));
      setTicketId(data.ticketId || "");
      setMessage("");
      setClientKey(crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : `sup${Date.now().toString(16)}`);
      persistDraft({ topic, email, message: "" });
    } catch {
      setError(t("support.error"));
    } finally {
      setSending(false);
    }
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
                minLength={10}
                maxLength={4000}
                rows={6}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={t("support.messagePlaceholder")}
                className="w-full resize-y rounded-wd border border-wd-border bg-[#0A0A0A] px-4 py-3 text-sm text-white outline-none transition-colors focus:border-wd-secondary/60"
              />
            </div>

            <button
              type="submit"
              disabled={sending}
              className="wd-button w-full rounded-wd-pill py-3 text-sm font-bold transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {sending ? t("support.sending") : t("support.submit")}
            </button>
          </form>

          {success ? (
            <p className="mt-4 text-sm text-wd-secondary">
              {success}
              {ticketId ? ` ${t("support.ticketId", { id: ticketId })}` : ""}
            </p>
          ) : null}
          {error ? <p className="mt-4 text-sm text-red-400">{error}</p> : null}
          <p className="mt-4 text-xs text-wd-text-secondary">{t("support.mailtoHint")}</p>
        </section>
      </main>

      <Footer />
    </div>
  );
}
