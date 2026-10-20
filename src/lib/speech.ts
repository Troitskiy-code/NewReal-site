// Client-safe settings. Semantic selection belongs to the server's AI preparation step.
export const SPEECH_VOICES = [
  { id: "Aoede", label: "aoede", gender: "female" },
  { id: "Kore", label: "kore", gender: "female" },
  { id: "Leda", label: "leda", gender: "female" },
  { id: "Zephyr", label: "zephyr", gender: "female" },
  { id: "Fenrir", label: "fenrir", gender: "male" },
  { id: "Charon", label: "charon", gender: "male" },
  { id: "Orus", label: "orus", gender: "male" },
  { id: "Puck", label: "puck", gender: "male" },
  // Retain the previously approved voice and existing manual preferences.
  { id: "Fola", label: "fola", gender: "other" },
] as const;
export type SpeechVoice = typeof SPEECH_VOICES[number]["id"];
export type SpeechVoiceChoice = SpeechVoice | "auto";
export type SpeechVoiceRole = "female" | "male" | "narrator" | "unknown";
export const DEFAULT_SPEECH_VOICE: SpeechVoice = "Fenrir";
export const FEMALE_SPEECH_VOICE: SpeechVoice = "Aoede";
export const NARRATOR_SPEECH_VOICE: SpeechVoice = "Charon";
export type SpeechVoiceDefault = { voice: SpeechVoice; role: SpeechVoiceRole };
export const SPEECH_MAX_CHARACTERS = 8_000;
export const SPEECH_SOURCE_MAX_CHARACTERS = 16_000;
export const SPEECH_PREPARATION_VERSION = "verbatim-performance-v1";
export type SpeechTurn = { text: string; style: string };
export type PreparedSpeech = { text: string; turns: SpeechTurn[] };
export type SpeechQuota = { enabled: boolean; unlimited: boolean; remaining: number | null; resetsAt: string };

export function isSpeechVoice(value: unknown): value is SpeechVoice {
  return SPEECH_VOICES.some(voice => voice.id === value);
}
export function isSpeechVoiceChoice(value: unknown): value is SpeechVoiceChoice {
  return value === "auto" || isSpeechVoice(value);
}

/** Normalize transport controls only; never discard narration, quotes or actions before AI selection. */
export function speechSource(content: string): string {
  return content.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}
