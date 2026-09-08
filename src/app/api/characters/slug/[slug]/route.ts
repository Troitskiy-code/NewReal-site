import { NextRequest, NextResponse } from "next/server";
import {
  findCharacterBySlugForViewer,
  getViewerId,
  toPublicCharacterPayload,
} from "@/lib/characterPublic";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const { slug } = await context.params;
    const viewerId = await getViewerId();
    const character = await findCharacterBySlugForViewer(slug, viewerId);

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    return NextResponse.json(toPublicCharacterPayload(character));
  } catch (error) {
    console.error("Character slug fetch error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
