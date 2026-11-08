import sharp from "sharp";
import { meteredPost } from "./aiCostTelemetry";
import { DEEPINFRA_CHAT_URL, providerApiKey } from "./aiProviders";

// A reference in full length, or lit dark, leaves the image model too little of the face, and likeness is lost
// (05.11 on Nano Banana, 08.11 on Seedream). A close-up of the face as a second reference keeps it. A vision model
// finds the face; on 2026-11-08 Gemma 4 Turbo boxed all six test avatars, a small dark face included.
export const FACE_LOCATE_MODEL = "google/gemma-4-31B-it-turbo";
export const FACE_REFERENCE_SENTENCE = "The second reference image is a close-up of the same face: use it for the facial likeness.";
const LOCATE_TIMEOUT_MS = 12_000;
const LOOK_SIZE = 768;
const CROP_SIZE = 1024;
// The box grows by this much around its center, so the crop keeps hair, chin and some neck.
const MARGIN = 1.7;
// A face that already fills this share of the image needs no close-up.
const ALREADY_CLOSE = 0.3;
const SYSTEM = 'You locate the face of the main person in an image. Reply with JSON only: {"face":[x0,y0,x1,y1]} where the numbers are the left, top, right and bottom edges of the face box, each from 0 to 1000 relative to the image width and height. The box covers the face from hairline to chin. If there is no clear face, reply {"face":null}.';

/** Puts the close-up sentence before the closing no-text rule, so the prompt still ends with it. */
export function withFaceReferenceSentence(prompt: string): string {
  const noText = prompt.lastIndexOf(" No text");
  return noText > 0 ? `${prompt.slice(0, noText)} ${FACE_REFERENCE_SENTENCE}${prompt.slice(noText)}` : `${prompt} ${FACE_REFERENCE_SENTENCE}`;
}

export function isReferenceFaceCropEnabled(): boolean {
  return (process.env['AVATAR_FACE_CROP_ENABLED'] ?? "").trim().toLowerCase() !== "false";
}

/** A box in 0..1000 units, or null when the answer has none or it is not a usable face box. */
export function parseFaceBox(raw: unknown): [number, number, number, number] | null {
  if (typeof raw !== "string") return null;
  const match = raw.match(/\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]/);
  if (!match) return null;
  const [x0, y0, x1, y1] = match.slice(1, 5).map(Number);
  if ([x0, y0, x1, y1].some(value => value < 0 || value > 1000) || x1 - x0 < 10 || y1 - y0 < 10) return null;
  return [x0, y0, x1, y1];
}

/** A square close-up around the face, as a WebP data URL, or null when none is needed or the face was not found. */
export async function cropReferenceFace(reference: string): Promise<string | null> {
  if (!isReferenceFaceCropEnabled()) return null;
  try {
    const source = Buffer.from(reference.slice(reference.indexOf(",") + 1), "base64");
    const { width, height } = await sharp(source).metadata();
    if (!width || !height) return null;
    const look = await sharp(source).resize({ width: LOOK_SIZE, height: LOOK_SIZE, fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
    const response = await meteredPost<{ choices?: Array<{ message?: { content?: unknown } }> }>("avatar_face_locate", DEEPINFRA_CHAT_URL, {
      model: FACE_LOCATE_MODEL, reasoning_effort: "none", temperature: 0, max_tokens: 80,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${look.toString("base64")}` } },
        { type: "text", text: "Locate the face." },
      ] }],
    }, { timeout: LOCATE_TIMEOUT_MS, maxContentLength: 64 * 1024,
      headers: { Authorization: `Bearer ${providerApiKey("deepinfra")}`, "Content-Type": "application/json" } });
    const box = parseFaceBox(response.data?.choices?.[0]?.message?.content);
    if (!box) return null;
    const [x0, y0, x1, y1] = [box[0] / 1000 * width, box[1] / 1000 * height, box[2] / 1000 * width, box[3] / 1000 * height];
    if ((x1 - x0) * (y1 - y0) >= ALREADY_CLOSE * width * height) return null;
    const side = Math.min(width, height, Math.round(Math.max(x1 - x0, y1 - y0) * MARGIN));
    const left = Math.round(Math.min(Math.max((x0 + x1) / 2 - side / 2, 0), width - side));
    const top = Math.round(Math.min(Math.max((y0 + y1) / 2 - side / 2, 0), height - side));
    const crop = await sharp(source).extract({ left, top, width: side, height: side })
      .resize({ width: CROP_SIZE, height: CROP_SIZE, fit: "fill", kernel: "lanczos3" }).webp({ quality: 90 }).toBuffer();
    return `data:image/webp;base64,${crop.toString("base64")}`;
  } catch {
    // Without a close-up the generation still runs on the main reference.
    return null;
  }
}
