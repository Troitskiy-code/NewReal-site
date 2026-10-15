import sharp from "sharp";
import { meteredPost } from "@/lib/aiCostTelemetry";
import { DEEPINFRA_CHAT_URL } from "@/lib/aiProviders";
import { parseTagsString } from "@/lib/characterTags";
import { parseArtStyle, type ArtStyle } from "@/lib/onboarding";

/** Classifies existing cards for the onboarding style filter (admin backfill only). */
export const ART_STYLE_VISION_MODEL = "google/gemma-3-27b-it";
const ANIME_WORDS = /\b(anime|manga|cel[- ]shad\w*)\b|аниме|манга/i;
const REALISTIC_WORDS = /\b(photo\w*|photorealistic|realistic|cinematic)\b|реалист\w*|фото\w*/i;

/** Tag first, then the avatar prompt; contradictory or silent cards stay unknown. */
export function guessArtStyle(tags: string | null, avatarPrompt: string | null): ArtStyle | null {
  if (parseTagsString(tags).includes("Аниме")) return "anime";
  const anime = ANIME_WORDS.test(avatarPrompt ?? ""), realistic = REALISTIC_WORDS.test(avatarPrompt ?? "");
  return anime === realistic ? null : anime ? "anime" : "realistic";
}

export async function visionArtStyle(imageUrl: string): Promise<{ style: ArtStyle | null; answer: string }> {
  // Stored avatars are mostly multi-megabyte data URLs; a small JPEG is enough to tell the style.
  let image = imageUrl;
  if (imageUrl.startsWith("data:")) {
    const bytes = Buffer.from(imageUrl.slice(imageUrl.indexOf(",") + 1), "base64");
    const jpeg = await sharp(bytes, { limitInputPixels: 64_000_000 }).rotate()
      .resize({ width: 448, height: 448, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    image = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } else if (!/^https:\/\//.test(imageUrl)) {
    return { style: null, answer: "unsupported image" };
  }
  const response = await meteredPost<{ choices?: { message?: { content?: string } }[] }>("art_style", DEEPINFRA_CHAT_URL, {
    model: ART_STYLE_VISION_MODEL, temperature: 0, max_tokens: 4,
    messages: [{ role: "user", content: [
      { type: "text", text: "Classify the art style of this character avatar. Reply with exactly one word: "
        + "anime (anime, manga, cel-shaded or cartoon-like drawing), realistic (photo, photorealistic image or realistic 3D render), "
        + "or other (painterly or stylized illustration that is neither)." },
      { type: "image_url", image_url: { url: image } },
    ] }],
  }, { timeout: 45_000, headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env['DEEPINFRA_API_KEY'] ?? ""}` } });
  const answer = response.data?.choices?.[0]?.message?.content?.trim().toLowerCase() ?? "";
  return { style: parseArtStyle(answer.replace(/[^a-z]/g, "")), answer: answer.slice(0, 20) };
}
