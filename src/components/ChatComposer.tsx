"use client";

import { useTranslation } from "react-i18next";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FaPaperPlane } from "react-icons/fa";
import { LuBookOpen, LuImagePlus, LuMic, LuPlus, LuSquare } from "react-icons/lu";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { STORY_SCENE_PRICE_VC } from "@/lib/storySceneShared";
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

/** Closes a popover on a press outside `root` or on Escape. */
function useDismiss(open: boolean, root: React.RefObject<HTMLElement | null>, close: (byKey: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, root, close]);
}

/** The writing guide. Desktop shows its own book button; on phones it opens from the composer's "+" menu. */
function ChatGuide({ billingNote, open, onOpenChange, showTrigger }: {
  billingNote?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showTrigger: boolean;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const guideId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useDismiss(open, rootRef, close);
  // Opened from the menu, the guide takes focus so screen readers announce it.
  useEffect(() => {
    if (open && !showTrigger) panelRef.current?.focus();
  }, [open, showTrigger]);

  return (
    <div ref={rootRef} className={showTrigger ? "shrink-0" : "contents"}>
      {showTrigger && <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={guideId}
        aria-label={t("chatGuide.title")}
        title={t("chatGuide.title")}
        className={`flex h-11 w-8 items-center justify-center rounded-full transition-colors hover:text-white ${
          open ? "text-white" : "text-secondary-text"
        }`}
      >
        <LuBookOpen size={18} aria-hidden />
      </button>}
      <div
        ref={panelRef}
        id={guideId}
        hidden={!open}
        tabIndex={showTrigger ? undefined : -1}
        role={showTrigger ? undefined : "dialog"}
        aria-label={showTrigger ? undefined : t("chatGuide.title")}
        className="absolute bottom-full right-0 z-30 mb-2 w-full max-w-xs rounded-xl border border-divider bg-bg-card px-3 py-2 text-xs leading-relaxed text-secondary-text shadow-xl focus:outline-none"
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

type MenuItem = { key: string; icon: React.ReactNode; label: string; price?: string; onSelect: () => void };

/** Phone-only "+" menu that holds the composer's secondary actions, so the text field keeps the width. */
function ComposerMenu({ items }: { items: MenuItem[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = useCallback((byKey: boolean) => {
    setOpen(false);
    if (byKey) triggerRef.current?.focus();
  }, []);
  useDismiss(open, rootRef, close);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  function onMenuKeyDown(event: React.KeyboardEvent) {
    const entries = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step || !entries.length) return;
    event.preventDefault();
    entries[(index + step + entries.length) % entries.length].focus();
  }

  return (
    <div ref={rootRef} className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(current => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t("chatUi.moreActions")}
        title={t("chatUi.moreActions")}
        className={`flex h-11 w-11 items-center justify-center rounded-full border border-divider bg-bg-card transition-colors hover:text-white ${
          open ? "text-white" : "text-secondary-text"
        }`}
      >
        <LuPlus size={20} aria-hidden className={`transition-transform ${open ? "rotate-45" : ""}`} />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-label={t("chatUi.moreActions")}
        hidden={!open}
        onKeyDown={onMenuKeyDown}
        className="absolute bottom-full left-0 z-30 mb-2 w-72 max-w-full overflow-hidden rounded-xl border border-divider bg-bg-card py-1 shadow-xl"
      >
        {items.map(item => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => { setOpen(false); triggerRef.current?.focus(); item.onSelect(); }}
            className="flex min-h-[44px] w-full items-center gap-3 px-3 py-2 text-left text-sm leading-snug text-primary-text transition-colors hover:bg-bg-card-hover focus:bg-bg-card-hover focus:outline-none"
          >
            <span className="flex w-5 shrink-0 justify-center text-secondary-text">{item.icon}</span>
            <span className="min-w-0 flex-1 break-words">{item.label}</span>
            {item.price && <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary-soft">{item.price}</span>}
          </button>
        ))}
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
  const voiceAvailable = voiceInputEnabled && voice.supported;
  const [guideOpen, setGuideOpen] = useState(false);
  // On phones the slot inside the field is the mic while the field is empty and the send button once there is text.
  const inlineMic = voiceAvailable && (dictating || !value.trim());
  const voiceLabel = t(recording ? "voiceInput.stop" : "voiceInput.start");
  const toggleVoice = () => (recording ? voice.stop() : void voice.start());
  const menuItems: MenuItem[] = [
    ...(onOpenSceneImage ? [{ key: "scene", icon: <LuImagePlus size={18} aria-hidden />, label: t("storyScene.title"),
      price: t("chatUi.priceVC", { price: STORY_SCENE_PRICE_VC }), onSelect: onOpenSceneImage }] : []),
    // With text in the field the inline slot sends, so dictation stays reachable from the menu.
    ...(voiceAvailable && !inlineMic && !disabled ? [{ key: "voice", icon: <LuMic size={18} aria-hidden />,
      label: t("voiceInput.start"), onSelect: () => void voice.start() }] : []),
    { key: "guide", icon: <LuBookOpen size={18} aria-hidden />, label: t("chatGuide.title"), onSelect: () => setGuideOpen(true) },
  ];

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
      {isDesktop ? null : <ComposerMenu items={menuItems} />}
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
          {isDesktop ? null : inlineMic ? (
            <button
              type="button"
              aria-label={voiceLabel}
              aria-describedby={voiceStatus ? voiceStatusId : undefined}
              title={voiceLabel}
              disabled={disabled || (dictating && !recording)}
              onClick={toggleVoice}
              className="group absolute bottom-0 right-0 flex h-11 w-11 items-center justify-center rounded-full disabled:opacity-50"
            >
              <span className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${recording
                ? "bg-red-500/15 text-red-400" : "text-secondary-text group-hover:text-white"}`}>
                {recording ? <LuSquare size={16} aria-hidden /> : <LuMic size={19} aria-hidden />}
              </span>
            </button>
          ) : (
            <button
              type="submit"
              data-metrika="chat-send"
              disabled={!sendEnabled}
              aria-label={t("chatUi.text054")}
              className="group absolute bottom-0 right-0 flex h-11 w-11 items-center justify-center rounded-full"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white transition-all group-hover:bg-primary-hover group-active:scale-[0.98] group-disabled:bg-primary/50">
                <FaPaperPlane className="block text-[13px]" />
              </span>
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
      {isDesktop && onOpenSceneImage && (
        <button type="button" onClick={onOpenSceneImage} aria-label={t("storyScene.title")} title={t("storyScene.title")}
          className="flex h-11 w-9 shrink-0 items-center justify-center rounded-full text-secondary-text transition-colors hover:text-white">
          <LuImagePlus size={19} aria-hidden />
        </button>
      )}
      {isDesktop && voiceAvailable && (
        <button type="button" aria-label={voiceLabel}
          aria-describedby={voiceStatus ? voiceStatusId : undefined}
          title={voiceLabel}
          disabled={disabled || (dictating && !recording)}
          onClick={toggleVoice}
          className={`flex h-11 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50 ${recording
            ? "bg-red-500/15 text-red-400" : "text-secondary-text hover:text-white"}`}>
          {recording ? <LuSquare size={17} aria-hidden /> : <LuMic size={19} aria-hidden />}
        </button>
      )}
      <ChatGuide billingNote={note} open={guideOpen} onOpenChange={setGuideOpen} showTrigger={isDesktop} />
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
