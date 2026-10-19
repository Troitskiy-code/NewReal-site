import { Mp3Encoder } from "@breezystack/lamejs";
import { setImmediate } from "node:timers/promises";

export const SPEECH_AUDIO_LIMIT = 8 * 1024 * 1024;
export const SPEECH_WAV_LIMIT = 40 * 1024 * 1024;

/** Accept only the provider's documented mono PCM16 / 24 kHz WAV. */
export async function speechWavToMp3(wav: Buffer): Promise<Buffer> {
  if (wav.length < 44 || wav.length > SPEECH_WAV_LIMIT || wav.toString("ascii", 0, 4) !== "RIFF"
    || wav.toString("ascii", 8, 12) !== "WAVE" || wav.readUInt32LE(4) + 8 !== wav.length) throw new Error("Invalid speech WAV");
  let offset = 12, validFormat = false, pcm: Buffer | null = null;
  while (offset + 8 <= wav.length) {
    const kind = wav.toString("ascii", offset, offset + 4), length = wav.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > wav.length) throw new Error("Truncated speech WAV");
    if (kind === "fmt ") validFormat = length >= 16 && wav.readUInt16LE(start) === 1
      && wav.readUInt16LE(start + 2) === 1 && wav.readUInt32LE(start + 4) === 24_000
      && wav.readUInt32LE(start + 8) === 48_000 && wav.readUInt16LE(start + 12) === 2 && wav.readUInt16LE(start + 14) === 16;
    if (kind === "data") { if (pcm) throw new Error("Multiple speech streams"); pcm = wav.subarray(start, start + length); }
    offset = start + length + (length % 2);
  }
  if (!validFormat || !pcm?.length || pcm.length % 2 || offset !== wav.length) throw new Error("Unsupported speech WAV");
  const encoder = new Mp3Encoder(1, 24_000, 64), chunks: Buffer[] = [];
  const samples = new Int16Array(1152);
  let bytes = 0;
  const append = (chunk: Uint8Array) => {
    bytes += chunk.byteLength;
    if (bytes > SPEECH_AUDIO_LIMIT) throw new Error("Speech MP3 too large");
    if (chunk.byteLength) chunks.push(Buffer.from(chunk));
  };
  for (let position = 0, block = 0; position < pcm.length; position += 2304, block++) {
    const count = Math.min(1152, (pcm.length - position) / 2);
    for (let i = 0; i < count; i++) samples[i] = pcm.readInt16LE(position + i * 2);
    append(encoder.encodeBuffer(samples.subarray(0, count)));
    if (block % 24 === 0) await setImmediate();
  }
  append(encoder.flush());
  const mp3 = Buffer.concat(chunks);
  if (mp3.length < 32 || mp3[0] !== 255 || (mp3[1] & 224) !== 224) throw new Error("Invalid speech MP3");
  return mp3;
}
