import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { errorLog, infoLog } from "@/lib/logger";

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

function errorDetails(error: unknown): { message: string; code?: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return { message, code: error.code };
  }
  return { message };
}

export async function POST(req: NextRequest) {
  console.log("[Admin:SimulateActivity] Start");
  console.log("[Admin:SimulateActivity] ADMIN_SECRET set:", Boolean(process.env.ADMIN_SECRET));

  try {
    if (!isAuthorized(req)) {
      console.log("[Admin:SimulateActivity] Unauthorized");
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const minRaw = Number(body?.min ?? DEFAULT_MIN);
    const maxRaw = Number(body?.max ?? DEFAULT_MAX);
    const onlyPublic = body?.onlyPublic !== false;

    console.log("[Admin:SimulateActivity] Params", { minRaw, maxRaw, onlyPublic });

    if (!Number.isFinite(minRaw) || !Number.isFinite(maxRaw)) {
      return NextResponse.json({ error: "min и max должны быть числами" }, { status: 400 });
    }

    const min = Math.max(0, Math.floor(minRaw));
    const max = Math.min(DEFAULT_MAX, Math.floor(maxRaw));

    if (min > max) {
      return NextResponse.json({ error: "min не может быть больше max" }, { status: 400 });
    }

    console.log("[Admin:SimulateActivity] Loading characters");
    const characters = await prisma.character.findMany({
      where: onlyPublic ? { isPublic: true } : {},
      select: { id: true, totalMessages: true },
    });
    console.log("[Admin:SimulateActivity] Loaded characters:", characters.length);

    const increments = characters.map((character) => ({
      id: character.id,
      delta: randomDelta(min, max),
    }));
    const totalAdded = increments.reduce((sum, item) => sum + item.delta, 0);
    const toApply = increments.filter((item) => item.delta > 0);

    console.log("[Admin:SimulateActivity] Applying updates:", toApply.length);

    if (toApply.length > 0) {
      await prisma.$executeRaw`
        UPDATE "Character"
        SET "totalMessages" = "totalMessages" + CASE "id"
          ${Prisma.join(
            toApply.map((item) => Prisma.sql`WHEN ${item.id} THEN ${item.delta}`),
            " "
          )}
        END
        WHERE "id" IN (${Prisma.join(toApply.map((item) => Prisma.sql`${item.id}`))})
      `;
    }

    infoLog(
      "Admin:SimulateActivity",
      `Updated ${characters.length} characters, added ${totalAdded} messages`,
      { onlyPublic, min, max, applied: toApply.length }
    );

    return NextResponse.json({
      success: true,
      updated: characters.length,
      totalAdded,
    });
  } catch (error) {
    console.error("[Admin:SimulateActivity] Error:", error);
    errorLog("Admin:SimulateActivity", "POST failed", error);
    const details = errorDetails(error);
    return NextResponse.json(
      {
        error: "Ошибка имитации активности",
        details: details.message,
        ...(details.code ? { code: details.code } : {}),
      },
      { status: 500 }
    );
  }
}
