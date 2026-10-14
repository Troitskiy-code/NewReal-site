import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { storeCharacterImage, MAX_CHARACTER_IMAGE_BYTES, CharacterMediaUnavailable } from "@/lib/characterMedia";
import { ClientInputError } from "@/lib/publicError";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    // Bound actual multipart bytes, including requests without Content-Length.
    const limit = MAX_CHARACTER_IMAGE_BYTES + 256 * 1024;
    if (Number(req.headers.get("content-length")) > limit) return NextResponse.json({ error: "Файл слишком большой" }, { status: 413 });
    const reader = req.body?.getReader();
    if (!reader) return NextResponse.json({ error: "Файл не загружен" }, { status: 400 });
    const chunks = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) return NextResponse.json({ error: "Файл слишком большой" }, { status: 413 });
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    let formData;
    try {
      formData = await new Request(req.url, { method: "POST", headers: { "Content-Type": req.headers.get("content-type") || "" },
        body: Buffer.concat(chunks) }).formData();
    } catch { return NextResponse.json({ error: "Некорректная загрузка файла" }, { status: 400 }); }
    const file = formData.get("file");

    if (!file || typeof file.arrayBuffer !== "function") {
      return NextResponse.json({ error: "Файл не загружен" }, { status: 400 });
    }

    // Проверка размера (максимум 5 МБ)
    if (file.size > MAX_CHARACTER_IMAGE_BYTES) {
      return NextResponse.json({ error: "Максимальный размер файла — 5 МБ" }, { status: 400 });
    }

    const url = await storeCharacterImage(Buffer.from(await file.arrayBuffer()), session.user.id);

    return NextResponse.json({ url }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ClientInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof CharacterMediaUnavailable) return NextResponse.json({ error: "Хранилище изображений временно недоступно. Попробуйте ещё раз." }, { status: 503 });
    errorLog("Server", "File upload error:", toSafeDiagnostic(error));
    return NextResponse.json(
      { error: "Ошибка загрузки файла" },
      { status: 500 }
    );
  }
}
