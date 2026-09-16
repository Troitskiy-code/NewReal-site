import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureCharacterModerationColumns } from "@/lib/ensureCharacterModerationColumns";
import { ensureNotificationTable } from "@/lib/ensureNotificationTable";
import { errorLog, infoLog } from "@/lib/logger";

function isAuthorized(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return false;
  const authHeader = req.headers.get("Authorization");
  return authHeader === `Bearer ${adminSecret}`;
}

async function notifyOwner(userId: string, characterId: string, characterName: string, reason: string) {
  try {
    await ensureNotificationTable();
    await prisma.notification.create({
      data: {
        userId,
        type: "admin",
        title: "Персонаж скрыт за нарушение правил",
        message: `«${characterName}» скрыт из публичного доступа. Причина: ${reason}`,
        link: `/edit/${characterId}`,
      },
    });
  } catch (error) {
    console.error("[Admin:Moderation] Failed to notify owner", error);
  }
}

export async function POST(req: NextRequest) {
  const startedAt = new Date().toISOString();

  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    await ensureCharacterModerationColumns();

    const body = await req.json().catch(() => ({}));
    const characterId = typeof body?.characterId === "string" ? body.characterId.trim() : "";
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    const action = body?.action === "delete" || body?.action === "warn" ? body.action : undefined;

    if (!characterId) {
      return NextResponse.json({ error: "characterId обязателен" }, { status: 400 });
    }
    if (!reason) {
      return NextResponse.json({ error: "reason обязателен" }, { status: 400 });
    }

    const character = await prisma.character.findUnique({
      where: { id: characterId },
      select: {
        id: true,
        name: true,
        userId: true,
        isPublic: true,
        violationCount: true,
        moderationStatus: true,
      },
    });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    if (action === "delete" || character.violationCount > 0) {
      await prisma.character.delete({ where: { id: characterId } });
      infoLog("Admin:Moderation", "deleted", {
        characterId,
        name: character.name,
        userId: character.userId,
        reason,
        at: startedAt,
      });
      console.log("[Admin:Moderation] deleted", {
        characterId,
        userId: character.userId,
        reason,
        at: startedAt,
      });
      return NextResponse.json({ success: true, action: "deleted" });
    }

    await prisma.character.update({
      where: { id: characterId },
      data: {
        isPublic: false,
        moderationStatus: "warning",
        moderationReason: reason,
        moderationWarnedAt: new Date(),
        violationCount: 1,
      },
    });
    await notifyOwner(character.userId, character.id, character.name, reason);

    infoLog("Admin:Moderation", "warned", {
      characterId,
      name: character.name,
      userId: character.userId,
      reason,
      at: startedAt,
    });
    console.log("[Admin:Moderation] warned", {
      characterId,
      userId: character.userId,
      reason,
      at: startedAt,
    });
    return NextResponse.json({ success: true, action: "warned" });
  } catch (error) {
    errorLog("Admin:Moderation", "POST failed", error);
    console.error("[Admin:Moderation] POST failed", error);
    return NextResponse.json({ error: "Ошибка модерации персонажа" }, { status: 500 });
  }
}
