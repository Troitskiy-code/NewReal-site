const MAX_SIDE = 512;
const WEBP_QUALITY = 82;

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

type SharpCtor = typeof import("sharp").default;

let sharpLoader: Promise<SharpCtor> | null = null;

async function loadSharp(): Promise<SharpCtor> {
  if (!sharpLoader) {
    sharpLoader = import("sharp")
      .then((mod) => mod.default)
      .catch((error) => {
        sharpLoader = null;
        throw error;
      });
  }
  return sharpLoader;
}

function formatKb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

function result(partial: CompressAvatarResult): CompressAvatarResult {
  return partial;
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

  try {
    const sharp = await loadSharp();
    const image = sharp(parsed.body).rotate();
    const meta = await image.metadata();
    const beforeWidth = meta.width ?? null;
    const beforeHeight = meta.height ?? null;

    if (!beforeWidth || !beforeHeight) {
      return unchanged("invalid", { beforeWidth, beforeHeight });
    }

    if (Math.max(beforeWidth, beforeHeight) <= MAX_SIDE) {
      return unchanged("already-small", { beforeWidth, beforeHeight });
    }

    const buffer = await image
      .clone()
      .resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();

    const afterMeta = await sharp(buffer).metadata();
    const next = `data:image/webp;base64,${buffer.toString("base64")}`;
    const afterBytes = Buffer.byteLength(next, "utf8");
    const afterWidth = afterMeta.width ?? null;
    const afterHeight = afterMeta.height ?? null;

    if (afterBytes >= beforeBytes) {
      return unchanged("not-smaller", { beforeWidth, beforeHeight });
    }

    return {
      imageUrl: next,
      changed: true,
      skipReason: null,
      beforeBytes,
      afterBytes,
      beforeWidth,
      beforeHeight,
      afterWidth,
      afterHeight,
    };
  } catch (error) {
    console.error("[compressAvatar] failed to compress data URL", error);
    return unchanged("error");
  }
}

export async function compressAvatarDataUrl(
  imageUrl: string | null | undefined
): Promise<string | null | undefined> {
  if (!isAvatarDataUrl(imageUrl)) return imageUrl;
  const compressed = await tryCompressAvatarDataUrl(imageUrl);
  return compressed.imageUrl;
}
