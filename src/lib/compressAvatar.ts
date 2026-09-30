import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Jimp } from "jimp";

const MAX_SIDE = 512;
const JPEG_QUALITY = 82;

export type CompressAvatarSkipReason =
  | "not-data-url"
  | "invalid"
  | "already-small"
  | "not-smaller"
  | "error";

export type CompressAvatarResult = {
  imageUrl: string;
  changed: boolean;
  skipReason: CompressAvatarSkipReason | null;
  beforeBytes: number;
  afterBytes: number;
  beforeWidth: number | null;
  beforeHeight: number | null;
  afterWidth: number | null;
  afterHeight: number | null;
};

type EncodedImage = {
  mime: string;
  buffer: Buffer;
  beforeWidth: number;
  beforeHeight: number;
  afterWidth: number;
  afterHeight: number;
};

let webpDecodeReady: Promise<typeof import("@jsquash/webp/decode.js").default> | null = null;

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

function formatKb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

function result(partial: CompressAvatarResult): CompressAvatarResult {
  return partial;
}

function isJimpFriendlyMime(mime: string): boolean {
  const lower = mime.toLowerCase();
  return (
    lower.includes("jpeg") ||
    lower.includes("jpg") ||
    lower.includes("png") ||
    lower.includes("gif") ||
    lower.includes("bmp") ||
    lower.includes("tiff")
  );
}

function isWebpBuffer(mime: string, body: Buffer): boolean {
  if (mime.toLowerCase().includes("webp")) return true;
  return (
    body.length >= 12 &&
    body.toString("ascii", 0, 4) === "RIFF" &&
    body.toString("ascii", 8, 12) === "WEBP"
  );
}

async function loadWebpDecode() {
  if (!webpDecodeReady) {
    webpDecodeReady = (async () => {
      const mod = await import("@jsquash/webp/decode.js");
      const wasmPath = join(process.cwd(), "node_modules/@jsquash/webp/codec/dec/webp_dec.wasm");
      const wasmBinary = await readFile(wasmPath);
      await mod.init({
        wasmBinary: wasmBinary.buffer.slice(
          wasmBinary.byteOffset,
          wasmBinary.byteOffset + wasmBinary.byteLength
        ),
      });
      return mod.default;
    })();
  }
  return webpDecodeReady;
}

function jimpFromBitmap(width: number, height: number, data: Buffer | Uint8Array | Uint8ClampedArray) {
  return new Jimp({
    width,
    height,
    data: Buffer.isBuffer(data) ? data : Buffer.from(data),
  });
}

async function finishJimp(
  image: InstanceType<typeof Jimp>,
  beforeWidth: number,
  beforeHeight: number
): Promise<EncodedImage> {
  if (Math.max(beforeWidth, beforeHeight) <= MAX_SIDE) {
    return {
      mime: "skip",
      buffer: Buffer.alloc(0),
      beforeWidth,
      beforeHeight,
      afterWidth: beforeWidth,
      afterHeight: beforeHeight,
    };
  }

  image.scaleToFit({ w: MAX_SIDE, h: MAX_SIDE });
  const buffer = Buffer.from(await image.getBuffer("image/jpeg", { quality: JPEG_QUALITY }));

  return {
    mime: "image/jpeg",
    buffer,
    beforeWidth,
    beforeHeight,
    afterWidth: image.bitmap?.width ?? image.width,
    afterHeight: image.bitmap?.height ?? image.height,
  };
}

async function encodeWithJimp(body: Buffer): Promise<EncodedImage> {
  const image = await Jimp.read(Buffer.from(body));
  const beforeWidth = image.bitmap?.width ?? image.width;
  const beforeHeight = image.bitmap?.height ?? image.height;
  if (!beforeWidth || !beforeHeight) {
    throw new Error("invalid image metadata");
  }
  return finishJimp(image, beforeWidth, beforeHeight);
}

async function encodeWithWebp(body: Buffer): Promise<EncodedImage> {
  const decode = await loadWebpDecode();
  const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  const imageData = await decode(arrayBuffer);
  const image = jimpFromBitmap(imageData.width, imageData.height, imageData.data);
  return finishJimp(image, imageData.width, imageData.height);
}

export function formatCompressAvatarLine(id: string, entry: CompressAvatarResult): string {
  const before = `${entry.beforeWidth ?? "?"}x${entry.beforeHeight ?? "?"}/${formatKb(entry.beforeBytes)} KB`;
  const after = `${entry.afterWidth ?? "?"}x${entry.afterHeight ?? "?"}/${formatKb(entry.afterBytes)} KB`;
  const savings =
    entry.beforeBytes > 0
      ? ((1 - entry.afterBytes / entry.beforeBytes) * 100).toFixed(1)
      : "0.0";
  const suffix = entry.changed
    ? `-${savings}%`
    : `0.0%${entry.skipReason ? ` skip (${entry.skipReason})` : ""}`;
  return `${id}  ${before} -> ${after}  ${suffix}`;
}

export async function tryCompressAvatarDataUrl(imageUrl: string): Promise<CompressAvatarResult> {
  const beforeBytes = Buffer.byteLength(imageUrl, "utf8");
  const unchanged = (
    skipReason: CompressAvatarSkipReason,
    extra?: Partial<CompressAvatarResult>
  ): CompressAvatarResult =>
    result({
      imageUrl,
      changed: false,
      skipReason,
      beforeBytes,
      afterBytes: beforeBytes,
      beforeWidth: extra?.beforeWidth ?? null,
      beforeHeight: extra?.beforeHeight ?? null,
      afterWidth: extra?.afterWidth ?? extra?.beforeWidth ?? null,
      afterHeight: extra?.afterHeight ?? extra?.beforeHeight ?? null,
    });

  if (!isAvatarDataUrl(imageUrl)) return unchanged("not-data-url");

  const parsed = parseDataUrl(imageUrl);
  if (!parsed?.body.length) return unchanged("invalid");

  const encoders = isWebpBuffer(parsed.mime, parsed.body)
    ? [encodeWithWebp, encodeWithJimp]
    : isJimpFriendlyMime(parsed.mime)
      ? [encodeWithJimp, encodeWithWebp]
      : [encodeWithJimp, encodeWithWebp];

  let lastError: unknown;
  for (const encode of encoders) {
    try {
      const encoded = await encode(parsed.body);
      if (encoded.mime === "skip") {
        return unchanged("already-small", {
          beforeWidth: encoded.beforeWidth,
          beforeHeight: encoded.beforeHeight,
        });
      }

      const next = `data:${encoded.mime};base64,${encoded.buffer.toString("base64")}`;
      const afterBytes = Buffer.byteLength(next, "utf8");
      if (afterBytes >= beforeBytes) {
        return unchanged("not-smaller", {
          beforeWidth: encoded.beforeWidth,
          beforeHeight: encoded.beforeHeight,
        });
      }

      return {
        imageUrl: next,
        changed: true,
        skipReason: null,
        beforeBytes,
        afterBytes,
        beforeWidth: encoded.beforeWidth,
        beforeHeight: encoded.beforeHeight,
        afterWidth: encoded.afterWidth,
        afterHeight: encoded.afterHeight,
      };
    } catch (error) {
      lastError = error;
    }
  }

  console.error("[compressAvatar] failed to compress data URL", lastError);
  return unchanged("error");
}

export async function compressAvatarDataUrl(
  imageUrl: string | null | undefined
): Promise<string | null | undefined> {
  if (!isAvatarDataUrl(imageUrl)) return imageUrl;
  const compressed = await tryCompressAvatarDataUrl(imageUrl);
  return compressed.imageUrl;
}
