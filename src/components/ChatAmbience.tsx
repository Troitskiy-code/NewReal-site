"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { LuAudioLines, LuVolume2, LuVolumeX } from "react-icons/lu";
import { storyAmbience, type StoryAmbience } from "@/lib/storyAmbience";
import { useChatSpeechPlaying } from "./ChatSpeech";

const PREFERENCE = "newverse:chat-ambience";
let sessionPreference = true;

function readPreference() {
  try {
    return localStorage.getItem(PREFERENCE) !== "off";
  } catch {
    return sessionPreference;
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

function savePreference(enabled: boolean) {
  sessionPreference = enabled;
  try {
    localStorage.setItem(PREFERENCE, enabled ? "on" : "off");
  } catch {
    // The setting still works until the page is reloaded.
  }
  window.dispatchEvent(new Event(PREFERENCE));
}

function play(audio: HTMLAudioElement) {
  if (!document.hidden && audio.getAttribute("src") && audio.paused && !audio.error) {
    // If autoplay is blocked, retry in the next user gesture.
    void audio.play().catch(() => {});
  }
}

function selectTrack(audio: HTMLAudioElement, track: StoryAmbience | null) {
  if (!track) {
    audio.pause();
    if (audio.hasAttribute("src")) {
      audio.removeAttribute("src");
      audio.load();
    }
    return;
  }
  const src = `/ambience/${track}.mp3`;
  if (audio.getAttribute("src") !== src) audio.src = src;
}

export default function ChatAmbience({ audioRef, messages, ready, pending }: {
  audioRef: RefObject<HTMLAudioElement | null>;
  messages: ReadonlyArray<{ role: string; content: string }>;
  ready: boolean;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const enabled = useSyncExternalStore(subscribe, readPreference, () => null);
  const speaking = useChatSpeechPlaying();
  const [playing, setPlaying] = useState(false);
  const descriptionId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const completedMessages = pending ? null : messages;
  const description = enabled === true ? t(playing ? "chatAmbience.playing" : "chatAmbience.silent") : undefined;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const start = () => setPlaying(true);
    const stop = () => setPlaying(false);
    const stopEvents = ["pause", "waiting", "emptied", "error"];
    audio.addEventListener("playing", start);
    for (const event of stopEvents) audio.addEventListener(event, stop);
    return () => {
      audio.removeEventListener("playing", start);
      for (const event of stopEvents) audio.removeEventListener(event, stop);
    };
  }, [audioRef]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = speaking ? 0.16 : 0.55;
  }, [audioRef, speaking]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!ready || !enabled) {
      selectTrack(audio, null);
      return;
    }
    // Keep the previous scene during generation, including edits to an existing reply.
    if (completedMessages) selectTrack(audio, storyAmbience(completedMessages));
    play(audio);
  }, [audioRef, enabled, completedMessages, ready]);

  useEffect(() => {
    const audio = audioRef.current;
    const button = toggleRef.current;
    if (!audio || !button || !ready || !enabled) return;
    const resumeOnGesture = (event: Event) => {
      if (event.target instanceof Node && button.contains(event.target)) return;
      play(audio);
    };
    const onVisibility = () => {
      if (document.hidden) audio.pause();
      else play(audio);
    };
    document.addEventListener("click", resumeOnGesture);
    document.addEventListener("keydown", resumeOnGesture);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("click", resumeOnGesture);
      document.removeEventListener("keydown", resumeOnGesture);
      document.removeEventListener("visibilitychange", onVisibility);
      audio.pause();
    };
  }, [audioRef, enabled, ready]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (enabled) {
      audio.pause();
      savePreference(false);
    } else {
      if (completedMessages) selectTrack(audio, storyAmbience(completedMessages));
      play(audio);
      savePreference(true);
    }
  }

  return <>
    <button ref={toggleRef} type="button" aria-label={t("chatAmbience.label")}
      aria-describedby={description ? descriptionId : undefined} aria-pressed={enabled !== false}
      title={description ? `${t("chatAmbience.label")} · ${description}` : t("chatAmbience.label")}
      disabled={!ready || enabled === null}
      onClick={toggle}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black/30 text-white transition-colors hover:text-wd-secondary-text disabled:opacity-50 md:bg-transparent">
      {enabled === false ? <LuVolumeX size={18} aria-hidden /> : playing
        ? <LuAudioLines size={18} aria-hidden /> : <LuVolume2 size={18} aria-hidden />}
    </button>
    {description && <span id={descriptionId} className="sr-only">{description}</span>}
  </>;
}
