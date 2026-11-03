/** Voice-independent scene script. Offsets refer to speechSource(message.content), in UTF-16 code units. */
export const SPEECH_RECOGNITION_VERSION = "scene-speakers-v1";
export type SceneSpeakerKind = "narrator" | "character" | "participant" | "npc";
export type SceneSpeaker = {
  id: string;
  name: string;
  kind: SceneSpeakerKind;
  aliases: string[];
};
export type RecognizedSpeechSegment = {
  text: string;
  start: number;
  end: number;
  speakerId: string;
  kind: "dialogue" | "narration";
  confidence: "certain" | "uncertain";
};
export type SpeechRecognitionResult = {
  version: string;
  sourceHash: string;
  contextHash: string;
  mode: "character" | "group" | "world";
  speakers: SceneSpeaker[];
  segments: RecognizedSpeechSegment[];
};
