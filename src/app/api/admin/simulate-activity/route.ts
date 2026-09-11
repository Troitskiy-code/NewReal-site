import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { errorLog, infoLog } from "@/lib/logger";

const BATCH_SIZE = 20;
const DEFAULT_MIN = 0;
const DEFAULT_MAX = 100;

function isAuthorized(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return false;
  }

  const authHeader = req.headers.get("Authorization");
  return authHeader === `Bearer ${adminSecret}`;
}

function randomDelta(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function POST(req: NextRequest) {
  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const minRaw = Number(body?.min ?? DEFAULT_MIN);
    const maxRaw = Number(body?.max ?? DEFAULT_MAX);
    const onlyPublic = body?.onlyPublic !== false;

    if (!Number.isFinite(minRaw) || !Number.isFinite(maxRaw)) {
      return NextResponse.json({ error: "min и max должны быть числами" }, { status: 400 });
    }

    const min = Math.max(0, Math.floor(minRaw));
    const max = Math.min(DEFAULT_MAX, Math.floor(maxRaw));

    if (min > max) {
      return NextResponse.json({ error: "min не может быть больше max" }, { status: 400 });
    }

    const characters = await prisma.character.findMany({
      where: onlyPublic ? { isPublic: true } : {},
      select: { id: true },
    });

    let totalAdded = 0;
    const updates = characters.flatMap((character) => {
      const delta = randomDelta(min, max);
      totalAdded += delta;
      if (delta === 0) return [];
      return [
        prisma.character.update({
          where: { id: character.id },
          data: { totalMessages: { increment: delta } },
        }),
      ];
    });

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      await Promise.all(updates.slice(i, i + BATCH_SIZE));
    }

    infoLog(
      "Admin:SimulateActivity",
      `Updated ${characters.length} characters, added ${totalAdded} messages`,
      { onlyPublic, min, max, batches: Math.ceil(updates.length / BATCH_SIZE) }
    );

    return NextResponse.json({
      success: true,
      updated: characters.length,
      totalAdded,
    });
  } catch (error) {
    errorLog("Admin:SimulateActivity", "POST failed", error);
    return NextResponse.json({ error: "Ошибка имитации активности" }, { status: 500 });
  }
}
