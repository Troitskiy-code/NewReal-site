import { NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

export async function POST(req) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");

    if (!file) {
      return NextResponse.json({ error: "Файл не загружен" }, { status: 400 });
    }

    // Проверка размера (максимум 5 МБ)
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "Максимальный размер файла — 5 МБ" }, { status: 400 });
    }

    // Создаём папку public/uploads, если её нет
    const uploadDir = path.join(process.cwd(), "public/uploads");
    await mkdir(uploadDir, { recursive: true });

    // Генерируем уникальное имя файла
    const ext = file.name.split(".").pop() || "jpg";
    const fileName = `${Date.now()}.${ext}`;
    const filePath = path.join(uploadDir, fileName);

    // Сохраняем файл
    const bytes = await file.arrayBuffer();
    await writeFile(filePath, Buffer.from(bytes));

    // Возвращаем URL для доступа (относительный путь)
    const url = `/uploads/${fileName}`;
    return NextResponse.json({ url });
  } catch (error) {
    console.error("File upload error:", error);
    return NextResponse.json(
      { error: "Ошибка загрузки файла" },
      { status: 500 }
    );
  }
}

// Отключаем встроенный парсер body, чтобы обрабатывать FormData вручную
export const config = {
  api: {
    bodyParser: false,
  },
};