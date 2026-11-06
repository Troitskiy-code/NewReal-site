"use client";

import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { LuAudioLines, LuVolumeX } from "react-icons/lu";
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

function selectTrack(audio: HTMLAudioElement, track: StoryAmbience) {
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
  const toggleRef = useRef<HTMLButtonElement>(null);
  const completedMessages = pending ? null : messages;

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = speaking ? 0.16 : 0.55;
  }, [audioRef, speaking]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!ready || !enabled) {
      audio.pause();
      if (audio.hasAttribute("src")) {
        audio.removeAttribute("src");
        audio.load();
      }
      return;
    }
    // Keep the previous scene during generation, including edits to an existing reply.
    if (completedMessages) selectTrack(audio, storyAmbience(completedMessages));
    else if (!audio.hasAttribute("src")) selectTrack(audio, "calm");
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
      selectTrack(audio, completedMessages ? storyAmbience(completedMessages) : "calm");
      play(audio);
      savePreference(true);
    }
  }

  return (
    <button ref={toggleRef} type="button" aria-label={t("chatAmbience.label")}
      aria-pressed={enabled !== false} title={t("chatAmbience.label")} disabled={!ready || enabled === null}
      onClick={toggle}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black/30 text-white transition-colors hover:text-wd-secondary-text disabled:opacity-50 md:bg-transparent">
      {enabled === false ? <LuVolumeX size={18} aria-hidden /> : <LuAudioLines size={18} aria-hidden />}
    </button>
  );
}
