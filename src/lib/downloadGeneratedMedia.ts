"use client";

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const ALLOWED_DATA_URL = /^data:(?:image\/(?:png|jpeg|webp|gif|avif)|video\/(?:mp4|webm));base64,/i;

function saveUrl(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Browser-only: never sends the source URL to a server-side proxy. */
export async function downloadGeneratedMedia(source: string, filename: string): Promise<"saved" | "opened"> {
  if (typeof source !== "string" || !source) throw new Error("Файл недоступен");
  if (ALLOWED_DATA_URL.test(source)) {
    if (source.length > MAX_DOWNLOAD_BYTES * 4 / 3 + 256) throw new Error("Файл слишком большой");
    saveUrl(source, filename);
    return "saved";
  }
  const url = new URL(source);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Недопустимый адрес файла");

  // CORS is enforced by the browser; credentials of this site are never attached.
  let response: Response;
  try {
    response = await fetch(url.href, { credentials: "omit", signal: AbortSignal.timeout(30000) });
  } catch {
    // Some providers forbid CORS. Let the user save the original from a separate tab.
    window.open(url.href, "_blank", "noopener,noreferrer");
    return "opened";
  }
  if (!response.ok) throw new Error("Не удалось скачать файл");
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!/^(?:image\/(?:png|jpeg|webp|gif|avif)|video\/(?:mp4|webm)|application\/octet-stream)$/.test(type)) {
    await response.body?.cancel();
    throw new Error("Неподдерживаемый формат файла");
  }
  if (Number(response.headers.get("content-length")) > MAX_DOWNLOAD_BYTES) {
    await response.body?.cancel();
    throw new Error("Файл слишком большой");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Файл недоступен");
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) throw new Error("Файл слишком большой");
      chunks.push(value.slice().buffer);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("Не удалось скачать файл");
  } finally {
    reader.releaseLock();
  }
  const objectUrl = URL.createObjectURL(new Blob(chunks, { type }));
  try { saveUrl(objectUrl, filename); }
  finally { setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); }
  return "saved";
}
