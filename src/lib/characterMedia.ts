import { createHash, randomUUID } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import sharp from "sharp";
import { ClientInputError } from "./publicError";
import { isStorySceneJobId, storySceneImagePath, storySceneScope, storySceneThreadId } from "./storySceneShared";

export const MAX_CHARACTER_IMAGE_BYTES = 5 * 1024 * 1024;
const MEDIA_PATH = /^\/api\/character-media\/([a-zA-Z0-9_-]{1,128})\/([a-f0-9]{32})$/;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,([A-Za-z0-9+/]+={0,2})$/i;

export class CharacterMediaUnavailable extends Error {
  constructor() { super("Character media storage unavailable"); this.name = "CharacterMediaUnavailable"; }
}

function storage() {
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const region = process.env.S3_REGION?.trim();
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) throw new CharacterMediaUnavailable();
  // Credentials may only go to the configured Yandex S3 endpoint.
  if (endpoint !== "https://storage.yandexcloud.net") throw new CharacterMediaUnavailable();
  return { bucket, client: new S3Client({ endpoint, region, forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey }, maxAttempts: 2,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" }) };
}

export function parseCharacterMediaPath(value: string | null | undefined) {
  const match = typeof value === "string" ? MEDIA_PATH.exec(value) : null;
  return match ? { ownerId: match[1], assetId: match[2], key: `characters/${match[1]}/${match[2]}.webp` } : null;
}

export async function storeCharacterImage(buffer: Buffer, ownerId: string, jobId?: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(ownerId)) throw new ClientInputError("Некорректный владелец изображения");
  if (!buffer.length || buffer.length > MAX_CHARACTER_IMAGE_BYTES) throw new ClientInputError("Максимальный размер изображения — 5 МБ");
  const configured = storage();
  let image: Buffer;
  try {
    const input = sharp(buffer, { limitInputPixels: 16_000_000, animated: false });
    const metadata = await input.metadata();
    if (!["png", "jpeg", "webp", "gif", "avif", "heif"].includes(metadata.format)) throw new Error("unsupported image");
    image = await input.rotate().resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 }).toBuffer();
  } catch {
    configured.client.destroy();
    throw new ClientInputError("Загрузите корректное изображение PNG, JPEG, WebP, GIF или AVIF");
  }
  // A provider-job retry overwrites its own object instead of creating orphan copies.
  const assetId = jobId ? createHash("sha256").update(jobId).digest("hex").slice(0, 32) : randomUUID().replaceAll("-", "");
  const path = `/api/character-media/${ownerId}/${assetId}`;
  try {
    await configured.client.send(new PutObjectCommand({ Bucket: configured.bucket,
      Key: parseCharacterMediaPath(path)!.key, Body: image, ContentType: "image/webp",
      CacheControl: "private, no-store" }), { abortSignal: AbortSignal.timeout(20_000) });
  } catch { throw new CharacterMediaUnavailable(); }
  finally { configured.client.destroy(); }
  return path;
}

/** Only a successfully uploaded, caller-owned reference can be attached to a new card. */
export async function persistCharacterImage(value: string | null | undefined, ownerId: string, existing?: string | null) {
  if (!value) return null;
  const media = parseCharacterMediaPath(value);
  if (media) {
    if (media.ownerId !== ownerId) throw new ClientInputError("Изображение принадлежит другому пользователю");
    if (value !== existing) {
      const configured = storage();
      try {
        await configured.client.send(new HeadObjectCommand({ Bucket: configured.bucket, Key: media.key }),
          { abortSignal: AbortSignal.timeout(10_000) });
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
          throw new ClientInputError("Изображение не найдено. Загрузите его повторно");
        throw new CharacterMediaUnavailable();
      } finally { configured.client.destroy(); }
    }
    return value;
  }
  const match = DATA_IMAGE.exec(value);
  if (match) {
    if (match[1].length > Math.ceil(MAX_CHARACTER_IMAGE_BYTES * 4 / 3))
      throw new ClientInputError("Максимальный размер изображения — 5 МБ");
    return storeCharacterImage(Buffer.from(match[1], "base64"), ownerId);
  }
  // Preserve existing legacy remote images; never fetch a new client-supplied URL.
  if (value === existing && /^(?:https?:\/\/|\/)/.test(value) && !value.startsWith("/api/character-media/")) return value;
  throw new ClientInputError("Загрузите изображение через редактор персонажа");
}

export async function characterMediaDownloadUrl(value: string): Promise<string> {
  const media = parseCharacterMediaPath(value);
  if (!media) throw new CharacterMediaUnavailable();
  const configured = storage();
  try {
    return await getSignedUrl(configured.client,
      new GetObjectCommand({ Bucket: configured.bucket, Key: media.key }), { expiresIn: 300 });
  } catch { throw new CharacterMediaUnavailable(); }
  finally { configured.client.destroy(); }
}

export async function readCharacterAvatarReference(value: string | null, ownerId: string): Promise<Buffer | null> {
  const media = parseCharacterMediaPath(value);
  if (media) {
    if (media.ownerId !== ownerId) throw new CharacterMediaUnavailable();
    return Buffer.from(await readStoredImage(media.key, 10_000));
  }
  // Older cards can contain an inline raster. Never make server requests to legacy external URLs.
  if (!value?.startsWith("data:")) return null;
  if (value.length > Math.ceil(MAX_CHARACTER_IMAGE_BYTES * 4 / 3) + 128) throw new CharacterMediaUnavailable();
  const match = DATA_IMAGE.exec(value);
  if (!match) throw new CharacterMediaUnavailable();
  return Buffer.from(match[1], "base64");
}

function storySceneKey(ownerId: string, threadId: string, jobId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(ownerId) || storySceneThreadId(storySceneScope(threadId)) !== threadId
    || !isStorySceneJobId(jobId)) throw new CharacterMediaUnavailable();
  return `story-scenes/${ownerId}/${threadId}/${jobId}.webp`;
}

export async function storeStorySceneImage(image: Buffer, ownerId: string, threadId: string, jobId: string) {
  const Key = storySceneKey(ownerId, threadId, jobId);
  if (!image.length || image.length > MAX_CHARACTER_IMAGE_BYTES) throw new CharacterMediaUnavailable();
  const configured = storage();
  try {
    await configured.client.send(new PutObjectCommand({ Bucket: configured.bucket, Key, Body: image,
      ContentType: "image/webp", CacheControl: "private, no-store" }), { abortSignal: AbortSignal.timeout(20_000) });
    return storySceneImagePath(threadId, jobId);
  } finally { configured.client.destroy(); }
}

export async function readStorySceneImage(ownerId: string, threadId: string, jobId: string) {
  return readStoredImage(storySceneKey(ownerId, threadId, jobId), 15_000);
}

async function readStoredImage(Key: string, timeout: number) {
  const configured = storage();
  try {
    const object = await configured.client.send(new GetObjectCommand({ Bucket: configured.bucket, Key }),
      { abortSignal: AbortSignal.timeout(timeout) });
    if (!object.Body || !object.ContentLength || object.ContentLength > MAX_CHARACTER_IMAGE_BYTES) throw new CharacterMediaUnavailable();
    return new Uint8Array(await object.Body.transformToByteArray());
  } finally { configured.client.destroy(); }
}
