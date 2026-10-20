import { isSpeechVoice, SPEECH_MAX_CHARACTERS, type SpeechTurn, type SpeechVoice } from "./speech";
import { speechWavToMp3, SPEECH_WAV_LIMIT } from "./speechAudio";

export const SPEECH_MODEL = "google/gemini-3-8-flash-lite-tts";
export const SPEECH_CACHE_VERSION = "gemini-lite-native-v1-mp3-64";
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
export function speechInput(input: string | SpeechTurn[], voice: SpeechVoice) {
  const turns = typeof input === "string" ? [{ text: input, style: "" }] : input;
  const text = turns.map(turn => turn.text).join(" ");
  if (!isSpeechVoice(voice) || !text.trim() || turns.length > 32 || Array.from(text).length > SPEECH_MAX_CHARACTERS + 512) throw new SpeechProviderError(undefined, true);
  const style = /[а-яё]/i.test(text)
    ? "Говори по-русски как носитель русского языка из России, с естественным нейтральным русским произношением без иностранного акцента. Разговорная речь, естественные интонации. Все числа, дату, время и сумму произноси по-русски. Озвучь только переданный текст, ничего не добавляй."
    : "Speak in the original language of the script as a native speaker, with natural pronunciation and conversational intonation. Read numbers, dates, times and amounts in that language. Speak only the provided text, without additions.";
  return { temperature: 1, filler_words: false, speakers: [{ speaker_id: "Speaker 1", voice_name: voice }],
    dialogue_turns: turns.map(turn => ({ speaker_id: "Speaker 1", style: `${style}${turn.style ? ` Delivery: ${turn.style}.` : ""}`, text: turn.text })) };
}
export async function submitSpeech(text: string | SpeechTurn[], voice: SpeechVoice): Promise<string> {
  const data = await request("createTask", { model: SPEECH_MODEL, input: speechInput(text, voice) });
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
export async function getSpeechTask(taskId: string): Promise<SpeechTask> {
  if (!isTaskId(taskId)) throw new SpeechProviderError();
  const data = await request(`recordInfo?taskId=${encodeURIComponent(taskId)}`);
  if (data.taskId !== taskId || data.model !== SPEECH_MODEL) throw new SpeechProviderError();
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
  if (!isSpeechAudioUrl(url)) throw new SpeechProviderError();
  try {
    // No credentials on media requests; reject redirects and untrusted destinations.
    const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) { await response.body?.cancel(); throw new SpeechProviderError(response.status, false, "media_http"); }
    const wav = await boundedBody(response, SPEECH_WAV_LIMIT);
    try { return await speechWavToMp3(wav); }
    catch { throw new SpeechProviderError(undefined, true, "media_format"); }
  } catch (error) {
    if (error instanceof SpeechProviderError) throw error;
    throw new SpeechProviderError(undefined, false,
      error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "media_timeout" : "media_network");
  }
}
