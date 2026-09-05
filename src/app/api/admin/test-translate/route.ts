import { NextRequest, NextResponse } from "next/server";
import { translateText, type TranslateTargetLang } from "@/lib/translate";

function isAuthorized(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return false;
  }

  const authHeader = req.headers.get("Authorization");
  return authHeader === `Bearer ${adminSecret}`;
}

export async function POST(req: NextRequest) {
  try {
    if (!isAuthorized(req)) {
      console.error("[Admin:Translate] Unauthorized request");
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const text = typeof body?.text === "string" ? body.text : undefined;
    const targetLangRaw = body?.targetLang;
    const targetLang: TranslateTargetLang = targetLangRaw === "ru" ? "ru" : "en";

    if (text === undefined || !text.trim()) {
      console.error("[Admin:Translate] Empty text rejected");
      return NextResponse.json(
        { error: "text обязателен и не должен быть пустым" },
        { status: 400 }
      );
    }

    console.log("[Admin:Translate] Start", {
      textLength: text.length,
      targetLang,
      textPreview: text.slice(0, 80),
    });

    const translated = await translateText(text, targetLang);

    console.log("[Admin:Translate] Success", {
      originalLength: text.length,
      translatedLength: translated.length,
    });

    return NextResponse.json({
      success: true,
      original: text,
      translated,
      targetLang,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Admin:Translate] Failed", message, error);
    return NextResponse.json(
      {
        success: false,
        error: "Ошибка перевода",
        details: message,
      },
      { status: 502 }
    );
  }
}
