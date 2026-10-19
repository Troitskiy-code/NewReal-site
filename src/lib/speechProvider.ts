import { isSpeechVoice, SPEECH_MAX_CHARACTERS, type SpeechVoice } from "./speech";
import { speechWavToMp3, SPEECH_WAV_LIMIT } from "./speechAudio";

export const SPEECH_MODEL = "google/gemini-3-8-flash-lite-tts";
export const SPEECH_CACHE_VERSION = "gemini-lite-native-v1-mp3-64";
const API = "https://api.kie.ai/api/v1/jobs";
export function speechEnabled(): boolean {
  return process.env.CHAT_SPEECH_ENABLED !== "false" && Boolean(process.env.KIE_API_KEY?.trim());
}
export class SpeechProviderError extends Error {
  constructor(public readonly status?: number, public readonly definitive = false) { super("Speech provider unavailable"); }
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
  } catch { throw new SpeechProviderError(); }
  let data;
  try { data = JSON.parse((await boundedBody(response, 64 * 1024)).toString("utf8")); }
  catch { throw new SpeechProviderError(response.status); }
  if (!response.ok || data?.code !== 200) {
    // Lost/HTTP 5xx creation responses never trigger another paid submission.
    throw new SpeechProviderError(response.status, response.ok || [400, 401, 402, 403, 404, 422, 429].includes(response.status));
  }
  if (!data.data || typeof data.data !== "object") throw new SpeechProviderError(response.status);
  return data.data;
}
export function speechInput(text: string, voice: SpeechVoice) {
  if (!isSpeechVoice(voice) || !text.trim() || Array.from(text).length > SPEECH_MAX_CHARACTERS) throw new SpeechProviderError(undefined, true);
  const style = /[а-яё]/i.test(text)
    ? "Говори по-русски как носитель русского языка из России, с естественным нейтральным русским произношением без иностранного акцента. Разговорная речь, естественные интонации. Все числа, дату, время и сумму произноси по-русски. Озвучь только переданный текст, ничего не добавляй."
    : "Speak in the original language of the script as a native speaker, with natural pronunciation and conversational intonation. Read numbers, dates, times and amounts in that language. Speak only the provided text, without additions.";
  return { temperature: 1, filler_words: false, speakers: [{ speaker_id: "Speaker 1", voice_name: voice }],
    dialogue_turns: [{ speaker_id: "Speaker 1", style, text }] };
}
export async function submitSpeech(text: string, voice: SpeechVoice): Promise<string> {
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
    if (!response.ok) { await response.body?.cancel(); throw new SpeechProviderError(response.status); }
    return await speechWavToMp3(await boundedBody(response, SPEECH_WAV_LIMIT));
  } catch { throw new SpeechProviderError(); }
}
