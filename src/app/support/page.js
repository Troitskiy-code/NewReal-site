"use client";

import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslation } from "react-i18next";
import Footer from "@/components/Footer";
import { METRIKA_GOALS, reachGoal } from "@/lib/metrika";
import { SUPPORT_DRAFT_KEY, SUPPORT_KEY_RE, newSupportClientKey, supportSubmissionPayload, supportSubmissionKey } from "@/lib/supportDraft";

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
  const [referenceTicketId, setReferenceTicketId] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [error, setError] = useState("");
  const [clientKey, setClientKey] = useState(newSupportClientKey);
  const [draftReady, setDraftReady] = useState(false);
  const submittedPayload = useRef(null);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => { if (!active) return; try {
      const raw = sessionStorage.getItem(SUPPORT_DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (typeof draft.email === "string") setEmail(draft.email);
      if (typeof draft.message === "string") setMessage(draft.message);
      if (typeof draft.referenceTicketId === "string") setReferenceTicketId(draft.referenceTicketId);
      if (isTopicKey(draft.topic)) setTopic(draft.topic);
      if (SUPPORT_KEY_RE.test(draft.clientKey ?? "")) setClientKey(draft.clientKey);
      if (typeof draft.submittedPayload === "string") submittedPayload.current = draft.submittedPayload;
    } catch {
      /* ignore */
    } finally { setDraftReady(true); } });
    return () => { active = false; };
  }, []);

  const persistDraft = (next) => {
    try {
      sessionStorage.setItem(SUPPORT_DRAFT_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!draftReady) return;
    const timer = setTimeout(() => {
      try { sessionStorage.setItem(SUPPORT_DRAFT_KEY, JSON.stringify({ topic, email, message, referenceTicketId, clientKey, submittedPayload: submittedPayload.current })); } catch { /* storage unavailable */ }
    }, 200);
    return () => clearTimeout(timer);
  }, [draftReady, topic, email, message, referenceTicketId, clientKey]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    setSending(true);
    const payload = supportSubmissionPayload(topic, email, message, referenceTicketId);
    const submissionKey = supportSubmissionKey(clientKey, submittedPayload.current, payload);
    submittedPayload.current = payload;
    setClientKey(submissionKey);
    persistDraft({ topic, email, message, referenceTicketId, clientKey: submissionKey, submittedPayload: payload });

    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-locale": i18n.language },
        body: JSON.stringify({ ...JSON.parse(payload), clientKey: submissionKey }),
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
      const nextKey = newSupportClientKey();
      setClientKey(nextKey);
      submittedPayload.current = null;
      persistDraft({ topic, email, message: "", referenceTicketId, clientKey: nextKey, submittedPayload: null });
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
              <label htmlFor="support-reference" className="block text-xs font-bold uppercase tracking-wider text-wd-text-secondary">
                {t("support.referenceTicket")}
              </label>
              <input
                id="support-reference"
                type="text"
                maxLength={128}
                value={referenceTicketId}
                onChange={(event) => setReferenceTicketId(event.target.value)}
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby="support-reference-hint"
                className="w-full rounded-wd border border-wd-border bg-[#0A0A0A] px-4 py-3 text-sm text-white outline-none transition-colors focus:border-wd-secondary/60"
              />
              <p id="support-reference-hint" className="text-xs leading-relaxed text-wd-text-secondary">{t("support.referenceHint")}</p>
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
              disabled={sending || !draftReady}
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
