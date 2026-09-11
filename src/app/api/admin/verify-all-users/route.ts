import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { errorLog, infoLog } from "@/lib/logger";

const LOG = "Admin:VerifyAll";

function isAuthorized(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return false;
  }

  const authHeader = req.headers.get("Authorization");
  return authHeader === `Bearer ${adminSecret}`;
}

export async function POST(req: NextRequest) {
  console.log("[Admin:VerifyAll] Start");
  console.log("[Admin:VerifyAll] ADMIN_SECRET set:", Boolean(process.env.ADMIN_SECRET));

  try {
    if (!isAuthorized(req)) {
      console.log("[Admin:VerifyAll] Unauthorized");
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const beforeRaw = typeof body?.before === "string" ? body.before.trim() : "";
    const beforeDate = beforeRaw ? new Date(beforeRaw) : new Date();

    if (Number.isNaN(beforeDate.getTime())) {
      return NextResponse.json({ error: "before должен быть валидной ISO-датой" }, { status: 400 });
    }

    console.log("[Admin:VerifyAll] Before", beforeDate.toISOString());

    const result = await prisma.user.updateMany({
      where: {
        emailVerified: null,
        createdAt: { lt: beforeDate },
      },
      data: { emailVerified: new Date() },
    });

    infoLog(LOG, `Updated ${result.count} users`, { before: beforeDate.toISOString() });

    return NextResponse.json({
      success: true,
      updated: result.count,
    });
  } catch (error) {
    console.error("[Admin:VerifyAll] Error:", error);
    errorLog(LOG, "POST failed", error);
    return NextResponse.json({ error: "Ошибка миграции верификации" }, { status: 500 });
  }
}
