// Reference images for avatar generation. The server accepts only PNG, JPEG, WebP or GIF data URLs
// up to 5 MB, so anything else the browser can open (AVIF, HEIC in Safari, BMP, a screenshot whose
// file has no or a non-standard MIME type) is re-encoded here before upload.

const SERVER_TYPES = /^image\/(png|jpeg|webp|gif)$/;
const MAX_SIDE = 2048;
/** Files of a server type this small are sent unchanged; everything else is re-encoded. */
const PASS_THROUGH_BYTES = 2 * 1024 * 1024;

export class ReferenceImageError extends Error {}

type Decoded = { source: CanvasImageSource; width: number; height: number; close(): void };

async function decodeImage(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Some browsers decode AVIF/HEIC only through <img>.
    }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new ReferenceImageError("Не удалось открыть изображение. Сохраните его как PNG или JPEG и загрузите снова.");
  }
  return { source: img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, close: () => URL.revokeObjectURL(url) };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
}

/** Decodes the image and re-encodes it as WebP (PNG where the browser cannot encode WebP), at most 2048 px. */
async function reencode(blob: Blob, name: string): Promise<File> {
  const image = await decodeImage(blob);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ReferenceImageError("Не удалось обработать изображение. Загрузите PNG или JPEG.");
    ctx.drawImage(image.source, 0, 0, canvas.width, canvas.height);
    let out = await canvasToBlob(canvas, "image/webp");
    if (!out || out.type !== "image/webp") out = await canvasToBlob(canvas, "image/png");
    if (!out || !SERVER_TYPES.test(out.type)) throw new ReferenceImageError("Не удалось обработать изображение. Загрузите PNG или JPEG.");
    const extension = out.type === "image/webp" ? ".webp" : ".png";
    return new File([out], (name.replace(/\.[^.]*$/, "") || "reference") + extension, { type: out.type });
  } finally {
    image.close();
  }
}

/**
 * Turns a picked file into one the server accepts: small PNG/JPEG/WebP/GIF files pass unchanged,
 * everything else (other formats, missing MIME type, large screenshots and photos) is re-encoded.
 */
export async function prepareReferenceImageFile(file: File): Promise<File> {
  if (SERVER_TYPES.test(file.type) && file.size <= PASS_THROUGH_BYTES) return file;
  return reencode(file, file.name);
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new ReferenceImageError("Не удалось прочитать изображение"));
    reader.readAsDataURL(blob);
  });
}

/** Data URL for the generation request: at most 2048 px, always a type the server accepts. */
export async function referenceFileToDataUrl(file: File): Promise<string> {
  if (file.type === "image/gif" && file.size <= PASS_THROUGH_BYTES) return readAsDataUrl(file);
  if (SERVER_TYPES.test(file.type) && file.size <= PASS_THROUGH_BYTES && typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const fits = Math.max(bitmap.width, bitmap.height) <= MAX_SIDE;
      bitmap.close();
      if (fits) return readAsDataUrl(file);
    } catch {
      // Fall through to re-encoding, which reports a readable error if the file cannot be opened.
    }
  }
  return readAsDataUrl(await reencode(file, file.name));
}

/**
 * A reference already shown in the form (a saved character's image, a blob: preview or a data URL).
 * Saved images are stored as /api/character-media/... paths, which the server will not fetch itself.
 */
export async function referenceSourceToDataUrl(source: string): Promise<string> {
  let blob: Blob;
  try {
    const response = await fetch(source, { credentials: "same-origin" });
    if (!response.ok) throw new Error(String(response.status));
    blob = await response.blob();
  } catch {
    throw new ReferenceImageError("Не удалось загрузить сохранённый референс. Загрузите изображение заново.");
  }
  return referenceFileToDataUrl(new File([blob], "reference", { type: blob.type }));
}
