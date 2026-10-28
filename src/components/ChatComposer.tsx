"use client";

import { useTranslation } from "react-i18next";

import { useEffect, useId, useRef, useState } from "react";
import { FaPaperPlane } from "react-icons/fa";
import { LuInfo } from "react-icons/lu";

const COMPOSER_MAX_LINES = 5;
const DESKTOP_MQ = "(min-width: 768px)";

function resizeComposer(el: HTMLTextAreaElement | null) {
  if (!el) return;
  const styles = window.getComputedStyle(el);
  const parsedLineHeight = Number.parseFloat(styles.lineHeight);
  const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : 20;
  const paddingY =
    Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
  const borderY =
    Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
  const maxHeight = lineHeight * COMPOSER_MAX_LINES + paddingY + borderY;
  el.style.height = "auto";
  const nextHeight = Math.min(el.scrollHeight, maxHeight);
  el.style.height = `${nextHeight}px`;
  el.style.overflowY = el.scrollHeight > maxHeight + 1 ? "auto" : "hidden";
}

/** Billing note behind an info button next to send, so it does not take four lines under the composer. */
function ComposerNote({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const noteId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={noteId}
        aria-label={t("chatUi.text052")}
        title={t("chatUi.text052")}
        className={`flex h-11 w-8 items-center justify-center rounded-full transition-colors hover:text-white ${
          open ? "text-white" : "text-secondary-text"
        }`}
      >
        <LuInfo size={18} aria-hidden />
      </button>
      <p
        id={noteId}
        hidden={!open}
        className="absolute bottom-full right-0 z-30 mb-2 w-full max-w-xs rounded-xl border border-divider bg-bg-card px-3 py-2 text-xs leading-relaxed text-secondary-text shadow-xl"
      >
        {text}
      </p>
    </div>
  );
}

export default function ChatComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  canSend,
  note,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  disabled: boolean;
  canSend: boolean;
  /** Billing rules, shown on demand from the info button. */
  note?: string;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_MQ);
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    resizeComposer(inputRef.current);
  }, [value]);

  return (
    <form
      onSubmit={onSubmit}
      className="chat-form relative mx-auto flex w-full max-w-3xl items-end gap-2"
      data-metrika="chat-form"
    >
      <div className="min-w-0 flex-1">
        <div style={{ position: "relative", lineHeight: 0 }}>
          <textarea
            ref={inputRef}
            rows={1}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onInput={(event) => resizeComposer(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (canSend) {
                  event.currentTarget.form?.requestSubmit();
                }
              }
            }}
            placeholder={t("chatUi.text053")}
            className={`block max-h-[7.625rem] min-h-[44px] w-full resize-none overflow-hidden rounded-[22px] border border-divider bg-bg-card py-2.5 pl-4 text-sm leading-5 outline-none transition-colors focus:border-primary/60 ${
              isDesktop ? "pr-4" : "pr-12"
            }`}
            disabled={disabled}
          />
          {isDesktop ? null : (
            <button
              type="submit"
              data-metrika="chat-send"
              disabled={!canSend}
              aria-label={t("chatUi.text054")}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white transition-all hover:bg-primary-hover active:scale-[0.98] disabled:bg-primary/50"
              style={{
                position: "absolute",
                right: 6,
                top: "50%",
                height: 32,
                width: 32,
                marginTop: -16,
              }}
            >
              <FaPaperPlane className="block text-[13px]" />
            </button>
          )}
        </div>
      </div>
      {note ? <ComposerNote text={note} /> : null}
      {isDesktop ? (
        <button
          type="submit"
          id="chat-send-btn"
          data-metrika="chat-send"
          disabled={!canSend}
          className="flex min-h-[44px] shrink-0 items-center justify-center rounded-full bg-primary px-6 py-2.5 text-sm font-bold text-white transition-all hover:bg-primary-hover active:scale-[0.98] disabled:bg-primary/50"
        >
          {t("chatUi.text054")}</button>
      ) : null}
    </form>
  );
}
