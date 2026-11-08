"use client";

import { useTranslation } from "react-i18next";

import { useEffect, useId, useRef, useState } from "react";
import { FaPaperPlane } from "react-icons/fa";
import { LuBookOpen, LuImagePlus, LuMic, LuSquare } from "react-icons/lu";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { VOICE_INPUT_SECONDS } from "@/lib/voiceInput";

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

function ChatGuide({ billingNote }: { billingNote?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const guideId = useId();

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
        aria-controls={guideId}
        aria-label={t("chatGuide.title")}
        title={t("chatGuide.title")}
        className={`flex h-11 w-8 items-center justify-center rounded-full transition-colors hover:text-white ${
          open ? "text-white" : "text-secondary-text"
        }`}
      >
        <LuBookOpen size={18} aria-hidden />
      </button>
      <div
        id={guideId}
        hidden={!open}
        className="absolute bottom-full right-0 z-30 mb-2 w-full max-w-xs rounded-xl border border-divider bg-bg-card px-3 py-2 text-xs leading-relaxed text-secondary-text shadow-xl"
      >
        <h2 className="font-semibold text-primary-text">{t("chatGuide.title")}</h2>
        <p className="mt-1">{t("chatGuide.action")}</p>
        <p>{t("chatGuide.thought")}</p>
        <p>{t("chatGuide.dialogue")}</p>
        <code className="mt-2 block rounded-md bg-bg-page px-2 py-1 text-primary-text">{t("chatGuide.example")}</code>
        {billingNote && <p className="mt-2 border-t border-divider pt-2">{billingNote}</p>}
      </div>
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
  voiceInputEnabled = false,
  onVoiceCaptureChange,
  onOpenSceneImage,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  disabled: boolean;
  canSend: boolean;
  /** Billing rules, shown below the chat guide when applicable. */
  note?: string;
  voiceInputEnabled?: boolean;
  onVoiceCaptureChange: (capturing: boolean) => void;
  /** Opens the story illustration dialog; the button is hidden without it. */
  onOpenSceneImage?: () => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isDesktop, setIsDesktop] = useState(false);
  const voiceStatusId = useId();
  const voice = useVoiceInput({
    enabled: voiceInputEnabled && !disabled,
    onCaptureChange: onVoiceCaptureChange,
    onText: text => {
      const draft = inputRef.current?.value ?? value;
      const separator = draft && !/\s$/.test(draft) ? " " : "";
      onChange(draft + separator + text);
    },
  });
  const dictating = voice.phase !== "idle";
  const sendEnabled = canSend && !dictating;
  const recording = voice.phase === "recording";
  const voiceStatus = voice.error ? t(`voiceInput.errors.${voice.error}`) : dictating
    ? t(`voiceInput.${voice.phase}`, { seconds: VOICE_INPUT_SECONDS }) : null;

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
      onSubmit={event => {
        if (dictating) event.preventDefault();
        else onSubmit(event);
      }}
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
                if (sendEnabled) {
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
              disabled={!sendEnabled}
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
      {voiceStatus && (
        <div className="absolute bottom-full left-0 z-20 mb-2 flex max-w-full items-center gap-3 rounded-xl border border-divider bg-bg-card px-3 py-2 text-xs shadow-xl">
          <span id={voiceStatusId} role={voice.error ? "alert" : "status"}>{voiceStatus}</span>
          {dictating && <button type="button" onClick={voice.cancel}
            className="shrink-0 font-semibold text-secondary-text hover:text-white">{t("voiceInput.cancel")}</button>}
        </div>
      )}
      {onOpenSceneImage && (
        <button type="button" onClick={onOpenSceneImage} aria-label={t("storyScene.title")} title={t("storyScene.title")}
          className="flex h-11 w-9 shrink-0 items-center justify-center rounded-full text-secondary-text transition-colors hover:text-white">
          <LuImagePlus size={19} aria-hidden />
        </button>
      )}
      {voiceInputEnabled && voice.supported && (
        <button type="button" aria-label={t(recording ? "voiceInput.stop" : "voiceInput.start")}
          aria-describedby={voiceStatus ? voiceStatusId : undefined}
          title={t(recording ? "voiceInput.stop" : "voiceInput.start")}
          disabled={disabled || (dictating && !recording)}
          onClick={() => recording ? voice.stop() : void voice.start()}
          className={`flex h-11 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50 ${recording
            ? "bg-red-500/15 text-red-400" : "text-secondary-text hover:text-white"}`}>
          {recording ? <LuSquare size={17} aria-hidden /> : <LuMic size={19} aria-hidden />}
        </button>
      )}
      <ChatGuide billingNote={note} />
      {isDesktop ? (
        <button
          type="submit"
          id="chat-send-btn"
          data-metrika="chat-send"
          disabled={!sendEnabled}
          className="flex min-h-[44px] shrink-0 items-center justify-center rounded-full bg-primary px-6 py-2.5 text-sm font-bold text-white transition-all hover:bg-primary-hover active:scale-[0.98] disabled:bg-primary/50"
        >
          {t("chatUi.text054")}</button>
      ) : null}
    </form>
  );
}
