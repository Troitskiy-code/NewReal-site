import { isSpeechVoice, SPEECH_MAX_CHARACTERS, type SpeechTurn, type SpeechVoice, type VoicedSpeechTurn } from "./speech";
import { speechWavToMp3, speechWavPcm, SPEECH_WAV_LIMIT } from "./speechAudio";

export const SPEECH_MODEL = "google/gemini-3-8-flash-lite-tts";
/** Paid plans: the fuller Gemini model (~1.7x the audio price), clearly more expressive in a blind comparison (2026-11-01). */
export const SPEECH_EXPRESSIVE_MODEL = "google/gemini-3-8-flash-tts";
export type SpeechModel = typeof SPEECH_MODEL | typeof SPEECH_EXPRESSIVE_MODEL;
export function speechModelFor(unlimited: boolean): SpeechModel {
  return unlimited ? SPEECH_EXPRESSIVE_MODEL : SPEECH_MODEL;
}
export function isSpeechModel(value: unknown): value is SpeechModel {
  return value === SPEECH_MODEL || value === SPEECH_EXPRESSIVE_MODEL;
}
export const SPEECH_CACHE_VERSION = "gemini-native-v2-mp3-64";
const API = "https://api.kie.ai/api/v1/jobs";
export function speechEnabled(): boolean {
  return process.env.CHAT_SPEECH_ENABLED !== "false" && Boolean(process.env.KIE_API_KEY?.trim());
}
export class SpeechProviderError extends Error {
  constructor(public readonly status?: number, public readonly definitive = false,
    public readonly reason = "provider_response") { super("Speech provider unavailable"); this.name = "SpeechProviderError"; }
}
function isTaskId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
async function boundedBody(response: Response, limit: number) {
  if (!response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel(); throw new SpeechProviderError();
  }
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new SpeechProviderError(); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
async function request(path: string, body?: unknown) {
  if (!speechEnabled()) throw new SpeechProviderError(undefined, true);
  let response: Response;
  try {
    response = await fetch(`${API}/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store",
      headers: { Authorization: `Bearer ${process.env.KIE_API_KEY!.trim()}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  } catch (error) { throw new SpeechProviderError(undefined, false,
    error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "api_timeout" : "api_network"); }
  let data;
  try { data = JSON.parse((await boundedBody(response, 64 * 1024)).toString("utf8")); }
  catch { throw new SpeechProviderError(response.status, false, "api_body"); }
  if (!response.ok || data?.code !== 200) {
    // Lost/HTTP 5xx creation responses never trigger another paid submission.
    const status = response.ok && typeof data?.code === "number" ? data.code : response.status;
    throw new SpeechProviderError(status, [400, 401, 402, 403, 404, 422, 429].includes(status), "api_rejected");
  }
  if (!data.data || typeof data.data !== "object") throw new SpeechProviderError(response.status);
  return data.data;
}
/** `narrator` gives narrator turns a second voice in the same recording; without it every turn uses `voice`. */
export function speechInput(input: string | SpeechTurn[], voice: SpeechVoice, narrator?: SpeechVoice) {
  const turns: SpeechTurn[] = typeof input === "string" ? [{ text: input, style: "" }] : input;
  const text = turns.map(turn => turn.text).join(" ");
  if (!isSpeechVoice(voice) || (narrator !== undefined && (!isSpeechVoice(narrator) || narrator === voice))
    || !text.trim() || turns.length > (narrator === undefined ? 32 : 64) || Array.from(text).length > SPEECH_MAX_CHARACTERS + 512) throw new SpeechProviderError(undefined, true);
  const russian = /[а-яё]/i.test(text);
  // An acted performance, not neutral narration: the turn style carries the character brief and the line's emotion.
  const acted = russian
    ? "Говори по-русски как носитель русского языка из России, без иностранного акцента. Это актёрская игра, а не дикторское чтение: живая выразительная подача с ясно слышимыми эмоциями персонажа. Все числа, дату, время и сумму произноси по-русски. Озвучь только переданный текст, ничего не добавляй."
    : "Speak in the original language of the script as a native speaker. This is an acted performance, not neutral narration: lively delivery with clearly audible emotion. Read numbers, dates, times and amounts in that language. Speak only the provided text, without additions.";
  const narrated = russian
    ? "Говори по-русски как носитель русского языка из России, без иностранного акцента. Ты рассказчик аудиокниги: читай повествование и действия выразительно, но спокойнее реплик героев, не изображай персонажа. Все числа, дату, время и сумму произноси по-русски. Озвучь только переданный текст, ничего не добавляй."
    : "Speak in the original language of the script as a native speaker. You are an audiobook narrator: read narration and actions expressively but calmer than the characters' lines, without impersonating a character. Read numbers, dates, times and amounts in that language. Speak only the provided text, without additions.";
  const second = narrator !== undefined && turns.some(turn => turn.speaker === "narrator");
  const characterSpeaks = !second || turns.some(turn => turn.speaker !== "narrator");
  // Declare only voices that actually speak: Speaker 1 is the first one heard, in a fixed order per cast.
  const speakers = [...(characterSpeaks ? [voice] : []), ...(second ? [narrator!] : [])]
    .map((voice_name, index) => ({ speaker_id: `Speaker ${index + 1}`, voice_name }));
  const idOf = (name: SpeechVoice) => speakers.find(speaker => speaker.voice_name === name)!.speaker_id;
  return { temperature: 1, filler_words: false, speakers,
    dialogue_turns: turns.map(turn => {
      const byNarrator = second && turn.speaker === "narrator";
      return { speaker_id: idOf(byNarrator ? narrator! : voice), style: `${byNarrator ? narrated : acted}${turn.style ? ` ${turn.style}` : ""}`, text: turn.text };
    }) };
}
export async function submitSpeech(text: string | SpeechTurn[], voice: SpeechVoice, model: SpeechModel = SPEECH_MODEL, narrator?: SpeechVoice): Promise<string> {
  const data = await request("createTask", { model, input: speechInput(text, voice, narrator) });
  if (!isTaskId(data.taskId)) throw new SpeechProviderError();
  return data.taskId;
}

/** Each contiguous batch uses at most two voices, including any narrator. */
export function sceneSpeechInput(turns: VoicedSpeechTurn[]) {
  const voices = [...new Set(turns.map(turn => turn.voice))];
  if (!turns.length || turns.length > 64 || voices.length > 2 || voices.some(voice => !isSpeechVoice(voice))
    || turns.some(turn => !turn.speakerId || !turn.text.trim())) throw new SpeechProviderError(undefined, true);
  // Reuse the established language, acting and narrator instructions for every line.
  const dialogue_turns = turns.map(turn => ({
    ...speechInput([{ ...turn, speaker: turn.speaker === "narrator" ? "narrator" : "character" }],
      turn.speaker === "narrator" ? (turn.voice === "Fenrir" ? "Aoede" : "Fenrir") : turn.voice,
      turn.speaker === "narrator" ? turn.voice : undefined).dialogue_turns[0],
    speaker_id: `Speaker ${voices.indexOf(turn.voice) + 1}`,
  }));
  if (Array.from(turns.map(turn => turn.text).join(" ")).length > SPEECH_MAX_CHARACTERS + 512) throw new SpeechProviderError(undefined, true);
  return { temperature: 1, filler_words: false, speakers: voices.map((voice_name, i) => ({ speaker_id: `Speaker ${i + 1}`, voice_name })), dialogue_turns };
}
export async function submitSceneSpeech(turns: VoicedSpeechTurn[], model: SpeechModel): Promise<string> {
  const data = await request("createTask", { model, input: sceneSpeechInput(turns) });
  if (!isTaskId(data.taskId)) throw new SpeechProviderError();
  return data.taskId;
}
export type SpeechTask = { state: "pending" | "ready" | "failed"; credits: number | null; url?: string };
export function isSpeechAudioUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && ["kie.ai", "redpandaai.co", "aiquickdraw.com"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}
export async function getSpeechTask(taskId: string, model: SpeechModel = SPEECH_MODEL): Promise<SpeechTask> {
  if (!isTaskId(taskId)) throw new SpeechProviderError();
  const data = await request(`recordInfo?taskId=${encodeURIComponent(taskId)}`);
  if (data.taskId !== taskId || data.model !== model) throw new SpeechProviderError();
  const credits = typeof data.creditsConsumed === "number" && Number.isFinite(data.creditsConsumed) && data.creditsConsumed >= 0 ? data.creditsConsumed : null;
  if (data.state === "fail") return { state: "failed", credits };
  if (["waiting", "queuing", "generating"].includes(data.state)) return { state: "pending", credits };
  if (data.state !== "success") throw new SpeechProviderError();
  let url;
  try { url = JSON.parse(data.resultJson).resultUrls?.[0]; } catch { throw new SpeechProviderError(); }
  if (!isSpeechAudioUrl(url)) throw new SpeechProviderError();
  return { state: "ready", credits, url };
}
export async function downloadSpeech(url: string): Promise<Buffer> {
  return downloadSpeechMedia(url, false);
}
export async function downloadSpeechPcm(url: string): Promise<Buffer> {
  return downloadSpeechMedia(url, true);
}
async function downloadSpeechMedia(url: string, pcm: boolean): Promise<Buffer> {
  if (!isSpeechAudioUrl(url)) throw new SpeechProviderError();
  try {
    // No credentials on media requests; reject redirects and untrusted destinations.
    const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) { await response.body?.cancel(); throw new SpeechProviderError(response.status, false, "media_http"); }
    const wav = await boundedBody(response, SPEECH_WAV_LIMIT);
    try { return pcm ? speechWavPcm(wav) : await speechWavToMp3(wav); }
    catch { throw new SpeechProviderError(undefined, true, "media_format"); }
  } catch (error) {
    if (error instanceof SpeechProviderError) throw error;
    throw new SpeechProviderError(undefined, false,
      error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "media_timeout" : "media_network");
  }
}
