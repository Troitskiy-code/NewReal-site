"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LuLoaderCircle, LuPause, LuPlay, LuVolume2 } from "react-icons/lu";
import LocaleLink from "./LocaleLink";
import { useTelegramMode } from "./TelegramProvider";
import { DEFAULT_SPEECH_VOICE, isSpeechVoice, isSpeechVoiceChoice, SPEECH_VOICES, type SpeechQuota, type SpeechVoice,
  type SpeechVoiceChoice, type SpeechVoiceDefault } from "@/lib/speech";
import { withThread } from "@/lib/chatThreadShared";

type Clip = { messageId: string; content: string; voice: SpeechVoice; choice: SpeechVoiceChoice; url: string };
type SpeechContextValue = {
  quota: SpeechQuota | null; voice: SpeechVoice; choice: SpeechVoiceChoice; automatic: SpeechVoiceDefault | null;
  setVoice: (voice: SpeechVoiceChoice) => void; refresh: () => void;
  loadingId: string | null; clip: Clip | null; paused: boolean; error: string | null; errorId: string | null;
  prepared: Record<string, { content: string; text: string }>;
  toggle: (id: string, content: string) => void;
  bindAudio: (audio: HTMLAudioElement | null) => void;
  setPaused: (value: boolean) => void; stop: (id: string) => void; playbackError: () => void; seek: (seconds: number) => void;
};
const SpeechContext = createContext<SpeechContextValue | null>(null);
const ERROR_CODES = new Set(["unauthorized", "notFound", "empty", "tooLong", "busy", "quota", "rateLimit", "changed", "pending", "uncertain"]);

export function ChatSpeechProvider({ characterId, threadId, userId, children }: {
  characterId: string; threadId: string | null; userId: string | null; children: ReactNode;
}) {
  const { t } = useTranslation();
  const endpoint = withThread(`/api/chat/${characterId}/speech`, threadId);
  const [quota, setQuota] = useState<SpeechQuota | null>(null);
  const [choice, setVoiceState] = useState<SpeechVoiceChoice>("auto");
  const [automatic, setAutomatic] = useState<SpeechVoiceDefault | null>(null);
  const voice = isSpeechVoice(choice) ? choice : automatic?.voice ?? DEFAULT_SPEECH_VOICE;
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [paused, setPaused] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Record<string, { content: string; text: string }>>({});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const clipRef = useRef<Clip | null>(null);
  useEffect(() => { clipRef.current = clip; }, [clip]);
  const bindAudio = useCallback((audio: HTMLAudioElement | null) => { audioRef.current = audio; }, []);
  const storageKey = `newverse:speech-voice:${userId ?? "guest"}:${characterId}`;

  const refreshQuota = useCallback(async (signal?: AbortSignal) => {
    if (!userId) return;
    try {
      const response = await fetch(endpoint, { cache: "no-store", signal });
      if (response.ok) {
        const state = await response.json() as SpeechQuota & { automatic?: SpeechVoiceDefault };
        if (mountedRef.current && !signal?.aborted) {
          setQuota(state);
          if (state.automatic && isSpeechVoice(state.automatic.voice)) setAutomatic(state.automatic);
        }
      }
    } catch { /* Controls stay hidden if configuration or the status service is unavailable. */ }
  }, [endpoint, userId]);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void refreshQuota(controller.signal);
      try {
        const saved = localStorage.getItem(storageKey);
        // The old key existed only after a deliberate voice change; preserve that manual choice once.
        const previous = saved === null ? localStorage.getItem(`newverse:speech-voice:${characterId}`) : null;
        if (isSpeechVoiceChoice(saved)) setVoiceState(saved);
        else if (isSpeechVoice(previous)) { setVoiceState(previous); localStorage.setItem(storageKey, previous); }
      } catch {}
    });
    return () => { mountedRef.current = false; controller.abort(); requestRef.current?.abort(); audioRef.current?.pause(); };
  }, [refreshQuota, storageKey, characterId]);
  // Refresh on the server's Moscow midnight, and after returning to this tab (e.g. after subscribing).
  useEffect(() => {
    if (!quota) return;
    const refresh = () => { if (document.visibilityState === "visible") void refreshQuota(); };
    const timer = setTimeout(() => void refreshQuota(), Math.max(1_000, Date.parse(quota.resetsAt) - Date.now() + 100));
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearTimeout(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [quota, refreshQuota]);
  useEffect(() => {
    if (!clip?.url) return;
    const url = clip.url;
    return () => URL.revokeObjectURL(url);
  }, [clip?.url]);

  const stop = useCallback((id: string) => {
    if (clipRef.current?.messageId === id) { audioRef.current?.pause(); setClip(null); setPaused(true); }
  }, []);
  const setVoice = (value: SpeechVoiceChoice) => {
    if (!isSpeechVoiceChoice(value) || requestRef.current) return;
    audioRef.current?.pause(); setClip(null); setPaused(true); setVoiceState(value); setError(null); setErrorId(null);
    try { localStorage.setItem(storageKey, value); } catch {}
  };
  const toggle = async (id: string, content: string) => {
    if (requestRef.current || !quota?.enabled) return;
    setError(null); setErrorId(id);
    // Pause/resume belongs to the authorized playback. After 'ended' the clip is cleared;
    // starting it again must go through the server, even if the MP3 is already cached.
    if (clip?.messageId === id && clip.content === content && clip.choice === choice && audioRef.current && !audioRef.current.ended) {
      if (!audioRef.current.paused) audioRef.current.pause();
      else {
        try { await audioRef.current.play(); } catch { setError(t("chatSpeech.errors.playback")); }
      }
      return;
    }
    audioRef.current?.pause(); setPaused(true);
    const controller = new AbortController(); requestRef.current = controller; setLoadingId(id);
    try {
      let response: Response;
      let requestedVoice: SpeechVoiceChoice = choice;
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId: id, voice: requestedVoice }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(100_000)]) });
        if (response.status !== 202) break;
        const state = await response.json();
        // Pin this task's resolved voice even if the card/story type changes during synthesis.
        if (isSpeechVoice(state.voice)) requestedVoice = state.voice;
        if (typeof state.text === "string" && mountedRef.current && !controller.signal.aborted)
          setPrepared(previous => ({ ...previous, [id]: { content, text: state.text } }));
        if (Date.now() >= deadline) throw new Error("pending");
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(controller.signal.reason); };
          const timer = setTimeout(() => { controller.signal.removeEventListener("abort", onAbort); resolve(); }, 4_000);
          if (controller.signal.aborted) onAbort();
          else controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const code = typeof body.code === "string" && ERROR_CODES.has(body.code) ? body.code : "unavailable";
        throw new Error(code);
      }
      const blob = await response.blob();
      if (!mountedRef.current || controller.signal.aborted) return;
      const unlimited = response.headers.get("X-Speech-Unlimited") === "true";
      setQuota({ enabled: true, unlimited, remaining: unlimited ? null : Number(response.headers.get("X-Speech-Remaining") ?? 0),
        resetsAt: response.headers.get("X-Speech-Resets-At") ?? quota.resetsAt });
      const actualVoice = response.headers.get("X-Speech-Voice");
      const playedVoice = isSpeechVoice(actualVoice) ? actualVoice : voice;
      setClip({ messageId: id, content, voice: playedVoice, choice, url: URL.createObjectURL(blob) });
      // Read the actual cached script; do not offer a local heuristic as an exact preview.
      const metadataUrl = new URL(endpoint, window.location.origin);
      metadataUrl.searchParams.set("messageId", id); metadataUrl.searchParams.set("voice", playedVoice);
      void fetch(metadataUrl, { cache: "no-store", signal: controller.signal }).then(async metadata => {
        if (!metadata.ok) return;
        const state = await metadata.json();
        if (typeof state.text === "string" && mountedRef.current && !controller.signal.aborted)
          setPrepared(previous => ({ ...previous, [id]: { content, text: state.text } }));
      }).catch(() => {});
    } catch (caught) {
      if (mountedRef.current && !controller.signal.aborted) {
        setError(t(`chatSpeech.errors.${caught instanceof Error && ERROR_CODES.has(caught.message) ? caught.message : "unavailable"}`));
        void refreshQuota();
      }
    } finally {
      requestRef.current = null;
      if (mountedRef.current) setLoadingId(null);
    }
  };

  return <SpeechContext.Provider value={{ quota, voice, choice, automatic, setVoice, refresh: refreshQuota, loadingId, clip, paused, error, errorId, prepared, toggle,
    bindAudio, setPaused, stop,
    seek: seconds => { if (audioRef.current && Number.isFinite(seconds)) audioRef.current.currentTime = seconds; },
    playbackError: () => { setErrorId(clip?.messageId ?? null); setError(t("chatSpeech.errors.playback")); } }}>{children}</SpeechContext.Provider>;
}

export function ChatSpeechControls({ onOpenSettings }: { onOpenSettings: () => void }) {
  const speech = useContext(SpeechContext);
  const { t } = useTranslation();
  const telegram = useTelegramMode();
  if (!speech?.quota?.enabled) return null;
  return <section aria-label={t("chatSpeech.label")} className="mb-3 rounded-xl border border-wd-border bg-wd-bg/60 px-3 py-2 font-sans text-xs text-wd-text-secondary">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p>{t(speech.quota.unlimited ? "chatSpeech.unlimited" : "chatSpeech.daily", { remaining: speech.quota.remaining })}</p>
      <button type="button" onClick={onOpenSettings} aria-label={t("chatSpeech.settingsTitle")}
        className="rounded-lg border border-wd-border px-2 py-1 text-wd-text hover:bg-white/5">
        {t("chatSpeech.voice")}: {speech.voice}{speech.choice === "auto" ? ` · ${t("chatSpeech.autoShort")}` : ""}
      </button>
    </div>
    {!speech.quota.unlimited && <p className="mt-1">{t("chatSpeech.reset")}{!telegram && <> · <LocaleLink href="/pricing" className="text-wd-secondary underline">{t("chatSpeech.upgrade")}</LocaleLink></>}</p>}
    <p className="mt-1">{t("chatSpeech.speechOnly")}</p>
  </section>;
}

export function ChatSpeechSettings() {
  const speech = useContext(SpeechContext);
  const { t } = useTranslation();
  const refresh = speech?.refresh;
  useEffect(() => { refresh?.(); }, [refresh]);
  if (!speech?.quota?.enabled) return <p className="text-sm text-wd-text-secondary">{t(speech?.quota ? "chatSpeech.settingsUnavailable" : "chatSpeech.settingsLoading")}</p>;
  const busy = Boolean(speech.loadingId);
  return <div className="space-y-5 text-sm text-wd-text">
    <p className="text-wd-text-secondary">{t("chatSpeech.settingsHint")}</p>
    <fieldset disabled={busy} className="space-y-4">
      <legend className="sr-only">{t("chatSpeech.settingsTitle")}</legend>
      <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${speech.choice === "auto" ? "border-wd-secondary bg-white/5" : "border-wd-border hover:bg-white/5"} ${busy ? "opacity-50" : ""}`}>
        <input type="radio" name="character-speech-voice" value="auto" checked={speech.choice === "auto"}
          onChange={() => speech.setVoice("auto")} className="mt-1 accent-wd-secondary" />
        <span><span className="block font-semibold">{t("chatSpeech.autoVoice", { voice: speech.automatic?.voice ?? DEFAULT_SPEECH_VOICE })}</span>
          <span className="mt-1 block text-xs leading-relaxed text-wd-text-secondary">{t(`chatSpeech.autoReasons.${speech.automatic?.role ?? "unknown"}`)}</span></span>
      </label>
      {(["female", "male", "other"] as const).map(gender => <div key={gender} className="space-y-2">
        <h3 className="font-semibold">{t(`chatSpeech.voiceGroups.${gender}`)}</h3>
        <div className="grid gap-2 sm:grid-cols-2">{SPEECH_VOICES.filter(voice => voice.gender === gender).map(voice => <label key={voice.id}
          className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${speech.choice === voice.id ? "border-wd-secondary bg-white/5" : "border-wd-border hover:bg-white/5"} ${busy ? "opacity-50" : ""}`}>
          <input type="radio" name="character-speech-voice" value={voice.id} checked={speech.choice === voice.id}
            onChange={() => speech.setVoice(voice.id)} className="mt-1 accent-wd-secondary" />
          <span><span className="block font-semibold">{voice.id}</span>
            <span className="mt-1 block text-xs leading-relaxed text-wd-text-secondary">{t(`chatSpeech.voiceDescriptions.${voice.label}`)}</span></span>
        </label>)}</div>
      </div>)}
    </fieldset>
    <p role="status" className="text-xs text-wd-text-secondary">{t(busy ? "chatSpeech.voiceChangeBusy" : "chatSpeech.voiceSaved")}</p>
  </div>;
}

export function MessageSpeechButton({ messageId, content, disabled }: { messageId: string; content: string; disabled: boolean }) {
  const speech = useContext(SpeechContext);
  const { t } = useTranslation();
  if (!speech?.quota?.enabled) return null;
  const loading = speech.loadingId === messageId;
  const playing = speech.clip?.messageId === messageId && !speech.paused;
  const spoken = content.trim();
  const label = t(loading ? "chatSpeech.loading" : playing ? "chatSpeech.pause" : "chatSpeech.listen");
  return <button type="button" aria-label={spoken ? label : t("chatSpeech.errors.empty")} title={spoken ? label : t("chatSpeech.errors.empty")} aria-pressed={playing} aria-busy={loading}
    disabled={disabled || !spoken || Boolean(speech.loadingId)} onClick={() => void speech.toggle(messageId, content)}
    className="flex h-8 shrink-0 items-center gap-1.5 rounded px-2 text-xs text-wd-text-secondary transition-colors hover:bg-white/5 hover:text-wd-text disabled:opacity-40">
    {loading ? <LuLoaderCircle aria-hidden className="animate-spin" /> : playing ? <LuPause aria-hidden /> : <LuVolume2 aria-hidden />}
    {label}
  </button>;
}

export function MessageSpeechPlayer({ messageId, content }: { messageId: string; content: string }) {
  const speech = useContext(SpeechContext);
  const { t } = useTranslation();
  const stop = speech?.stop;
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  useEffect(() => () => stop?.(messageId), [messageId, content, stop]);
  if (!speech?.quota?.enabled) return null;
  const activeClip = speech.clip?.messageId === messageId && speech.clip.content === content ? speech.clip : null;
  const spoken = speech.prepared[messageId]?.content === content ? speech.prepared[messageId].text : null;
  const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  return <>
    {spoken && <details className="mt-1 font-sans text-xs text-wd-text-secondary">
      <summary className="cursor-pointer">{t("chatSpeech.preview")}</summary>
      <p className="mt-1 whitespace-pre-wrap">{spoken}</p>
    </details>}
    {speech.errorId === messageId && speech.error && <p role="alert" className="mt-1 font-sans text-xs text-red-400">{speech.error}</p>}
    {activeClip && <div role="group" aria-label={t("chatSpeech.player")} className="mt-2 flex w-full max-w-sm items-center gap-2 rounded-xl border border-wd-border bg-wd-bg/60 px-2 py-1.5 font-sans text-xs text-wd-text-secondary">
    <button type="button" aria-label={t(speech.paused ? "chatSpeech.resume" : "chatSpeech.pause")}
      onClick={() => void speech.toggle(messageId, content)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-white/10">
      {speech.paused ? <LuPlay aria-hidden /> : <LuPause aria-hidden />}
    </button>
    <span className="shrink-0 tabular-nums">{time(position)} / {time(duration)}</span>
    <input type="range" aria-label={t("chatSpeech.seek")} min={0} max={duration || 1} step={0.1}
      value={Math.min(position, duration || 1)} disabled={!duration} onChange={event => { const value = Number(event.target.value); speech.seek(value); setPosition(value); }}
      className="min-w-0 flex-1 accent-wd-secondary" />
    <audio hidden autoPlay playsInline preload="auto" src={activeClip.url} ref={element => speech.bindAudio(element)}
    aria-label={t("chatSpeech.player")}
    onLoadedMetadata={event => { const value = event.currentTarget.duration; setDuration(Number.isFinite(value) ? value : 0); setPosition(0); }}
    onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
    onPlay={() => speech.setPaused(false)} onPause={() => speech.setPaused(true)} onEnded={() => speech.stop(messageId)}
    onError={speech.playbackError} />
    </div>}
  </>;
}
