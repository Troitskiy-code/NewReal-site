import sharp from "sharp";

const MAX_SIDE = 512;
const WEBP_QUALITY = 82;

export type CompressAvatarResult = {
  imageUrl: string;
  changed: boolean;
  beforeBytes: number;
  afterBytes: number;
};

function parseDataUrl(value: string): { mime: string; body: Buffer } | null {
  if (!value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma < 0) return null;
  const header = value.slice("data:".length, comma);
  const payload = value.slice(comma + 1);
  const parts = header.split(";");
  const mime = parts[0]?.trim() || "application/octet-stream";
  const base64 = parts.some((part) => part.trim().toLowerCase() === "base64");
  const body = Buffer.from(payload, base64 ? "base64" : "utf8");
  return { mime, body };
}

export function isAvatarDataUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}

export async function tryCompressAvatarDataUrl(imageUrl: string): Promise<CompressAvatarResult> {
  const beforeBytes = Buffer.byteLength(imageUrl, "utf8");
  const unchanged = {
    imageUrl,
    changed: false,
    beforeBytes,
    afterBytes: beforeBytes,
  };

  if (!isAvatarDataUrl(imageUrl)) return unchanged;

  const parsed = parseDataUrl(imageUrl);
  if (!parsed?.body.length) return unchanged;

  try {
    const buffer = await sharp(parsed.body)
      .rotate()
      .resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();

    const next = `data:image/webp;base64,${buffer.toString("base64")}`;
    const afterBytes = Buffer.byteLength(next, "utf8");
    if (afterBytes >= beforeBytes) return unchanged;

    return { imageUrl: next, changed: true, beforeBytes, afterBytes };
  } catch (error) {
    console.error("[compressAvatar] failed to compress data URL", error);
    return unchanged;
  }
}

export async function compressAvatarDataUrl(
  imageUrl: string | null | undefined
): Promise<string | null | undefined> {
  if (!isAvatarDataUrl(imageUrl)) return imageUrl;
  const result = await tryCompressAvatarDataUrl(imageUrl);
  return result.imageUrl;
}
