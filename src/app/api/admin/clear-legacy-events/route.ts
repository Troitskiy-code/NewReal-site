import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const LEGACY_EVENT_TYPES = ["action", "travel", "discovery"] as const;

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
      console.error("[Admin:ClearLegacy] Unauthorized");
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    if (!body || typeof body !== "object" || (body as { confirm?: unknown }).confirm !== true) {
      console.warn("[Admin:ClearLegacy] Rejected without confirm=true");
      return NextResponse.json(
        { error: 'Подтвердите удаление: передайте { "confirm": true }' },
        { status: 400 }
      );
    }

    console.log(
      `[Admin:ClearLegacy] Deleting WorldEvent types=${LEGACY_EVENT_TYPES.join(",")}`
    );

    const result = await prisma.worldEvent.deleteMany({
      where: { type: { in: [...LEGACY_EVENT_TYPES] } },
    });

    console.log(`[Admin:ClearLegacy] Deleted ${result.count} events`);

    return NextResponse.json({ success: true, deletedCount: result.count });
  } catch (error) {
    console.error("[Admin:ClearLegacy] Failed", error);
    return NextResponse.json({ error: "Не удалось удалить события" }, { status: 500 });
  }
}
