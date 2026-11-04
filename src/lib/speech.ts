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
export const SPEECH_PREPARATION_VERSION = "verbatim-performance-v3-content-mode";
/** Narration and actions kept for a separate narrator voice: its own cache identity next to the v3 policy. */
export const SPEECH_NARRATOR_PREPARATION_VERSION = "verbatim-performance-v4-narrator";
/** Narrates a single-character reply when the character itself was given the narrator's voice. */
export const NARRATOR_ALTERNATE_SPEECH_VOICE: SpeechVoice = "Kore";
export type SpeechContentMode = "dialogue" | "scene";
export function isSpeechContentMode(value: unknown): value is SpeechContentMode { return value === "dialogue" || value === "scene"; }
/** A turn without a speaker belongs to the character (scripts prepared before the narrator voice). */
export type SpeechSpeaker = "character" | "narrator";
export type SpeechTurn = { text: string; style: string; speaker?: SpeechSpeaker; gender?: "female" | "male"; speakerId?: string; voice?: SpeechVoice };
export type VoicedSpeechTurn = SpeechTurn & { speakerId: string; voice: SpeechVoice };
/** The provider mixes at most two voices into one recording. */
export type SpeechCast = { character: SpeechVoice; narrator: SpeechVoice };
export type PreparedSpeech = { text: string; turns: SpeechTurn[] };
export type SpeechQuota = { enabled: boolean; unlimited: boolean; remaining: number | null; resetsAt: string };

export function isSpeechVoice(value: unknown): value is SpeechVoice {
  return SPEECH_VOICES.some(voice => voice.id === value);
}
export function isSpeechVoiceChoice(value: unknown): value is SpeechVoiceChoice {
  return value === "auto" || isSpeechVoice(value);
}

/**
 * Who reads what in a narrated recording. A single character keeps the selected voice and gets a separate narrator;
 * in a world or group the selected voice narrates and spoken lines use a voice of the main speaker's gender.
 */
export function speechCast(voice: SpeechVoice, contentMode: SpeechContentMode, turns: SpeechTurn[]): SpeechCast {
  if (contentMode === "dialogue")
    return { character: voice, narrator: voice === NARRATOR_SPEECH_VOICE ? NARRATOR_ALTERNATE_SPEECH_VOICE : NARRATOR_SPEECH_VOICE };
  const gender = turns.find(turn => turn.speaker !== "narrator" && turn.gender)?.gender;
  const [first, second]: SpeechVoice[] = gender === "female" ? [FEMALE_SPEECH_VOICE, "Kore"] : [DEFAULT_SPEECH_VOICE, "Orus"];
  return { narrator: voice, character: first === voice ? second : first };
}

/** Normalize transport controls only; never discard narration, quotes or actions before AI selection. */
export function speechSource(content: string): string {
  return content.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}
