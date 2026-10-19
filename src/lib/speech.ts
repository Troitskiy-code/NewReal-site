import { splitStoryChoices } from "./storyChoices";

// Client-safe speech rules shared with the server, including the exact text preview.
export const SPEECH_VOICES = [
  { id: "Fola", label: "fola" },
  { id: "Fenrir", label: "fenrir" },
] as const;
export type SpeechVoice = typeof SPEECH_VOICES[number]["id"];
export const DEFAULT_SPEECH_VOICE: SpeechVoice = "Fola";
export const SPEECH_MAX_CHARACTERS = 8_000;
export type SpeechQuota = { enabled: boolean; unlimited: boolean; remaining: number | null; resetsAt: string };

export function isSpeechVoice(value: unknown): value is SpeechVoice {
  return SPEECH_VOICES.some(voice => voice.id === value);
}

/** Remove explicitly marked RP actions without another paid model call.
 * Plain unmarked text remains dialogue; ambiguous prose is exposed in the UI preview.
 */
export function speechText(content: string): string {
  const choices = splitStoryChoices(content);
  let text = (choices ? `${choices.before}\n${choices.after}` : content)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<(?:em|i)\b[^>]*>[\s\S]*?<\/(?:em|i)>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*[^*]*\*(?:\s*)/g, " ")
    .replace(/(?<![\p{L}\p{N}])_[^_]*_(?![\p{L}\p{N}])/gu, " ")
    // An unfinished action is safer to omit than to synthesize.
    .replace(/(?:^|\s)[*_][^*_\n]*$/gm, " ");
  let previous: string;
  do { previous = text; text = text.replace(/\([^()]*\)|\[[^\[\]]*\]/g, " "); } while (text !== previous);

  // Quoted dialogue with words of the author outside the quotation marks.
  const quotes = [...text.matchAll(/«([^«»]+)»|“([^“”]+)”|„([^„“]+)“|"([^"\n]+)"/g)];
  const directQuotes = quotes.length && (
    /(?:^|\n)\s*[«“„"]/.test(text) || /[:.!?]\s*[«“„"]/.test(text)
    || /[»”“"]\s*[,—–-]\s*(?:сказ|ответ|спрос|прошеп|произн|добав|он\b|она\b|said\b|asked\b|she\b|he\b)/iu.test(text)
  );
  if (directQuotes) text = quotes.map(match => match.slice(1).find(Boolean)).join(" ");
  else {
    const lines = text.split(/\r?\n/);
    const spoken = lines.filter(line => /^\s*[—–-]\s+\S/.test(line));
    if (spoken.length) text = spoken.map(line => line.replace(/^\s*[—–-]\s+/, "")
      .replace(/\s*[—–]\s*(?:[^—–\n]*?(?<!\p{L})(?:сказал[аи]?|ответил[аи]?|спросил[аи]?|прошептал[аи]?|улыбнул[а-я]*|произн[её]с[а-я]*|добавил[аи]?|said|asked|replied|whispered)(?!\p{L}))[^—–\n]*(?:[—–]\s*|$)/giu, " "))
      .join(" ");
  }
  return text
    .replace(/^[ \t]*#{1,6}\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ").trim();
}
