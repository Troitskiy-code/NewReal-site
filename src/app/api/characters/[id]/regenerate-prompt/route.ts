import { NextResponse } from "next/server";

// Retired writer: never overwrite or regenerate legacy prompts, even for an owner.
export async function POST() {
  return NextResponse.json({ error: "Отдельная генерация промпта отключена. Инструкции собираются из полей карточки автоматически." }, { status: 410 });
}
