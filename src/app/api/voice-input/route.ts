import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { providerApiKey } from "@/lib/aiProviders";
import { deepinfraFetch } from "@/lib/deepinfraNetwork";
import { consumeIpRateLimit, consumeRateLimit, retryAfterSeconds } from "@/lib/rateLimit";
import { isSameOriginRequest } from "@/lib/telegram/http";
import { VOICE_INPUT_MAX_BYTES, VOICE_INPUT_MIN_BYTES, VOICE_INPUT_SAMPLE_RATE } from "@/lib/voiceInput";

export const runtime = "nodejs";

const ASR_URL = "https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo";
const PRIVATE = { "Cache-Control": "private, no-store" };

function problem(code: string, status: number, headers?: Record<string, string>) {
  return Response.json({ code }, { status, headers: { ...PRIVATE, ...headers } });
}

function wavFile(pcm: Buffer): Blob {
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const text = new TextEncoder();
  wav.set(text.encode("RIFF"), 0);
  view.setUint32(4, wav.length - 8, true);
  wav.set(text.encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, VOICE_INPUT_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_INPUT_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  wav.set(text.encode("data"), 36);
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return new Blob([wav], { type: "audio/wav" });
}

export async function POST(req: Request) {
  try {
    if (!isSameOriginRequest(req)) return problem("forbidden", 403);
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return problem("unauthorized", 401);
    if (req.headers.get("content-type") !== "application/octet-stream") return problem("capture", 415);
    if (Number(req.headers.get("content-length")) > VOICE_INPUT_MAX_BYTES) return problem("capture", 413);
    const apiKey = providerApiKey("deepinfra");

    // Apply a shared abuse backstop and a per-account allowance before accepting audio.
    const ipLimit = await consumeIpRateLimit(req, "voice-input", { limit: 30, sharedLimit: 180, windowMs: 60_000 });
    if (!ipLimit.ok) return problem("rateLimit", 429, { "Retry-After": retryAfterSeconds(ipLimit) });
    const accountLimit = await consumeRateLimit(`voice-input:${session.user.id}`, 60, 86_400_000);
    if (!accountLimit.ok) return problem("rateLimit", 429, { "Retry-After": retryAfterSeconds(accountLimit) });

    const reader = req.body?.getReader();
    if (!reader) return problem("empty", 422);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > VOICE_INPUT_MAX_BYTES) {
          await reader.cancel();
          return problem("capture", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (size % 2) return problem("capture", 400);
    if (size < VOICE_INPUT_MIN_BYTES) return problem("empty", 422);
    const pcm = Buffer.concat(chunks, size);
    let audible = false;
    for (let i = 0; i < pcm.length; i += 2) {
      if (Math.abs(pcm.readInt16LE(i)) > 64) {
        audible = true;
        break;
      }
    }
    if (!audible) return problem("empty", 422);

    const body = new FormData();
    body.set("audio", wavFile(pcm), "dictation.wav");
    const response = await deepinfraFetch(ASR_URL, {
      method: "POST", body, headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "error", signal: AbortSignal.any([req.signal, AbortSignal.timeout(25_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return problem("unavailable", 503);
    }
    const result: unknown = await response.json();
    const text = (result as { text?: unknown } | null)?.text;
    if (typeof text !== "string") return problem("unavailable", 503);
    if (!text.trim()) return problem("empty", 422);
    return Response.json({ text: text.trim().slice(0, 12_000) }, { headers: PRIVATE });
  } catch {
    return problem("unavailable", 503);
  }
}
