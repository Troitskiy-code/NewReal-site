/** Voice-independent scene script. Offsets refer to speechSource(message.content), in UTF-16 code units. */
export const SPEECH_RECOGNITION_VERSION = "scene-speakers-v2-voices";
export type SceneSpeakerKind = "narrator" | "character" | "participant" | "npc";
export type SceneSpeaker = {
  id: string;
  name: string;
  kind: SceneSpeakerKind;
  aliases: string[];
  gender?: "female" | "male";
};
export type RecognizedSpeechSegment = {
  text: string;
  start: number;
  end: number;
  speakerId: string;
  kind: "dialogue" | "narration";
  confidence: "certain" | "uncertain";
  corrected?: boolean;
};
export type SpeechRecognitionResult = {
  version: string;
  sourceHash: string;
  contextHash: string;
  mode: "character" | "group" | "world";
  speakers: SceneSpeaker[];
  segments: RecognizedSpeechSegment[];
  revision?: string;
};

/** Old saved scripts have a deterministic initial revision; edits receive a fresh server revision. */
export function speechRecognitionRevision(result: SpeechRecognitionResult): string {
  return result.revision ?? `${result.sourceHash}:${result.contextHash}`;
}
