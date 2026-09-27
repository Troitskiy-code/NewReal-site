"use client";

import { useEffect, useRef, useState } from "react";
import { FaPaperPlane } from "react-icons/fa";

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

export default function ChatComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  canSend,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  disabled: boolean;
  canSend: boolean;
}) {
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
      className="chat-form mx-auto flex w-full max-w-3xl items-end gap-2"
      data-metrika="chat-form"
    >
      <div className="relative min-w-0 flex-1">
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
          placeholder="Напишите сообщение..."
          className={`max-h-[7.625rem] min-h-[44px] w-full resize-none overflow-hidden rounded-2xl border border-divider bg-bg-card py-2.5 pl-4 text-sm leading-5 outline-none transition-colors focus:border-primary/60 ${
            isDesktop ? "pr-4" : "pr-12"
          }`}
          disabled={disabled}
        />
        {isDesktop ? null : (
          <button
            type="submit"
            data-metrika="chat-send"
            disabled={!canSend}
            aria-label="Отправить"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white transition-all hover:bg-primary-hover active:scale-[0.98] disabled:bg-primary/50"
            style={{ position: "absolute", right: 6, bottom: 6 }}
          >
            <FaPaperPlane className="relative left-px text-[13px]" />
          </button>
        )}
      </div>
      {isDesktop ? (
        <button
          type="submit"
          id="chat-send-btn"
          data-metrika="chat-send"
          disabled={!canSend}
          className="flex min-h-[44px] shrink-0 items-center justify-center rounded-full bg-primary px-6 py-2.5 text-sm font-bold text-white transition-all hover:bg-primary-hover active:scale-[0.98] disabled:bg-primary/50"
        >
          Отправить
        </button>
      ) : null}
    </form>
  );
}
