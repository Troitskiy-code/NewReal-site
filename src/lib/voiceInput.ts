export const VOICE_INPUT_SAMPLE_RATE = 16_000;
export const VOICE_INPUT_SECONDS = 30;
export const VOICE_INPUT_MAX_SAMPLES = VOICE_INPUT_SAMPLE_RATE * VOICE_INPUT_SECONDS;
export const VOICE_INPUT_MAX_BYTES = VOICE_INPUT_MAX_SAMPLES * 2;
export const VOICE_INPUT_MIN_BYTES = VOICE_INPUT_SAMPLE_RATE / 2;
export const VOICE_INPUT_PATH = "/api/voice-input";
export const VOICE_INPUT_WORKLET = "/voice-input-worklet.js";

export type VoiceInputError = "permission" | "capture" | "empty" | "rateLimit" | "unavailable";
