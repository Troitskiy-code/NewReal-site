"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LuAudioLines, LuMusic, LuVolume2, LuVolumeX, LuWind } from "react-icons/lu";
import { storyAmbience } from "@/lib/storyAmbience";
import { isSceneMood, sceneBed, SCENE_MOOD_MESSAGE_LIMIT, type SceneMood } from "@/lib/sceneMusicShared";
import { SceneAudioMixer } from "@/lib/sceneAudioMixer";
import { useChatSpeechPlaying } from "./ChatSpeech";

const PREFERENCE = "newverse:chat-audio";
/** The earlier on/off switch for ambience; "off" keeps all scene sound off for those readers. */
const LEGACY_PREFERENCE = "newverse:chat-ambience";
const DEFAULT_LEVELS = "50,60";
let sessionPreference: string | null = null;

function readPreference() {
  try {
    const saved = localStorage.getItem(PREFERENCE);
    if (saved && /^\d{1,3},\d{1,3}$/.test(saved)) return saved;
    return localStorage.getItem(LEGACY_PREFERENCE) === "off" ? "0,0" : DEFAULT_LEVELS;
  } catch {
    return sessionPreference ?? DEFAULT_LEVELS;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(PREFERENCE, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREFERENCE, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function savePreference(music: number, bed: number) {
  const value = `${music},${bed}`;
  sessionPreference = value;
  try {
    localStorage.setItem(PREFERENCE, value);
  } catch {
    // The levels still apply until the page is reloaded.
  }
  window.dispatchEvent(new Event(PREFERENCE));
}

export default function ChatAmbience({ messages, ready, pending, capturingVoice }: {
  messages: ReadonlyArray<{ role: string; content: string }>;
  ready: boolean;
  pending: boolean;
  capturingVoice: boolean;
}) {
  const { t } = useTranslation();
  const preference = useSyncExternalStore(subscribe, readPreference, () => null);
  const [musicPercent, bedPercent] = (preference ?? "0,0").split(",").map(Number);
  const speaking = useChatSpeechPlaying();
  const [playing, setPlaying] = useState(false);
  const [mood, setMood] = useState<SceneMood | null>(null);
  const [open, setOpen] = useState(false);
  const mixerRef = useRef<SceneAudioMixer | null>(null);
  const candidateRef = useRef<SceneMood | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const musicId = useId();
  const bedId = useId();
  const completedMessages = pending ? null : messages;
  const turns = completedMessages?.filter(message => message.role === "user" || message.role === "assistant")
    .slice(-SCENE_MOOD_MESSAGE_LIMIT).map(message => message.content) ?? null;
  const turnsKey = turns?.length ? JSON.stringify(turns) : null;
  const musicOn = musicPercent > 0;
  const off = preference !== null && !musicOn && bedPercent <= 0;

  useEffect(() => {
    const mixer = new SceneAudioMixer(setPlaying);
    mixerRef.current = mixer;
    return () => { mixer.dispose(); mixerRef.current = null; };
  }, []);

  useEffect(() => {
    mixerRef.current?.setLevels(ready ? musicPercent / 100 : 0, ready ? bedPercent / 100 : 0);
  }, [musicPercent, bedPercent, ready]);

  useEffect(() => { mixerRef.current?.setDucked(speaking); }, [speaking]);
  useEffect(() => { mixerRef.current?.setMuted(capturingVoice); }, [capturingVoice]);

  // Keep the previous scene during generation, including edits to an existing reply.
  useEffect(() => {
    if (completedMessages) mixerRef.current?.setBed(sceneBed(storyAmbience(completedMessages)));
  }, [completedMessages]);

  // The theme changes only after two replies agree, so one odd line does not jerk the music around.
  useEffect(() => {
    if (!ready || !musicOn || !turnsKey) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch("/api/scene-mood", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: JSON.parse(turnsKey) }), signal: controller.signal })
        .then(response => response.ok ? response.json() as Promise<{ mood?: unknown }> : null)
        .then(data => {
          const mixer = mixerRef.current;
          if (!mixer || !isSceneMood(data?.mood)) return;
          const next = data.mood;
          if (mixer.currentMood && next !== mixer.currentMood && candidateRef.current !== next) {
            candidateRef.current = next;
            return;
          }
          candidateRef.current = null;
          mixer.playMood(next);
          setMood(next);
        })
        .catch(() => {});
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [turnsKey, ready, musicOn]);

  useEffect(() => {
    const mixer = mixerRef.current;
    if (!mixer || !ready || off) return;
    // Browsers start sound only after a gesture; the first tap anywhere unlocks it.
    const unlock = () => mixer.unlock();
    const onVisibility = () => mixer.setHidden(document.hidden);
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ready, off]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function setLevel(kind: "music" | "bed", value: number) {
    mixerRef.current?.unlock();
    savePreference(kind === "music" ? value : musicPercent, kind === "bed" ? value : bedPercent);
  }

  const status = off ? t("chatAmbience.off") : mood ? t("chatAmbience.nowPlaying", { mood: t(`chatAmbience.moods.${mood}`) })
    : t("chatAmbience.choosing");
  const slider = (id: string, label: string, icon: ReactNode, value: number, kind: "music" | "bed") => <div className="grid gap-1.5">
    <label htmlFor={id} className="flex items-center justify-between gap-2 text-xs text-wd-text-secondary">
      <span className="flex items-center gap-1.5">{icon}{label}</span>
      <output htmlFor={id} className="tabular-nums">{value}%</output>
    </label>
    <input id={id} type="range" min={0} max={100} step={5} value={value} disabled={preference === null}
      onChange={event => setLevel(kind, Number(event.target.value))} className="w-full accent-[#e0507f]" />
  </div>;

  return <div ref={rootRef} className="relative">
    <button type="button" aria-label={t("chatAmbience.label")} aria-expanded={open} aria-controls={panelId}
      title={`${t("chatAmbience.label")} · ${status}`} disabled={!ready || preference === null}
      onClick={() => { mixerRef.current?.unlock(); setOpen(current => !current); }}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black/30 text-white transition-colors hover:text-wd-secondary-text disabled:opacity-50 md:bg-transparent">
      {off ? <LuVolumeX size={18} aria-hidden /> : playing ? <LuAudioLines size={18} aria-hidden /> : <LuVolume2 size={18} aria-hidden />}
    </button>
    <div id={panelId} hidden={!open} role="group" aria-label={t("chatAmbience.label")}
      className="absolute right-0 top-full z-50 mt-2 grid w-64 gap-3 rounded-xl border border-[#2a2638] bg-[#15131d] p-4 text-white shadow-xl">
      <p className="text-sm font-semibold">{t("chatAmbience.label")}</p>
      {slider(musicId, t("chatAmbience.music"), <LuMusic size={14} aria-hidden />, musicPercent, "music")}
      {slider(bedId, t("chatAmbience.ambience"), <LuWind size={14} aria-hidden />, bedPercent, "bed")}
      <p role="status" className="text-xs text-wd-text-secondary">{status}</p>
    </div>
  </div>;
}
