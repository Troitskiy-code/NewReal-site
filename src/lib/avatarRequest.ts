export class AvatarBodyTooLarge extends Error {}
/** Bound chunked requests too; Content-Length alone is not an input limit. */
export async function readAvatarBody(req: Request, limit: number): Promise<string> {
  if (Number(req.headers.get("content-length")) > limit) throw new AvatarBodyTooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new AvatarBodyTooLarge();
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts).toString("utf8");
}
