import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureNotificationTable } from "@/lib/ensureNotificationTable";
import { errorLog, infoLog } from "@/lib/logger";

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
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    const body = await req.json();
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const link = typeof body?.link === "string" && body.link.trim() ? body.link.trim() : null;
    const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
    const broadcast = body?.broadcast === true;

    if (!title || !message) {
      return NextResponse.json({ error: "title и message обязательны" }, { status: 400 });
    }

    if (!broadcast && !userId) {
      return NextResponse.json(
        { error: "Укажите userId или broadcast: true" },
        { status: 400 }
      );
    }

    await ensureNotificationTable();

    if (broadcast) {
      const users = await prisma.user.findMany({ select: { id: true } });
      if (users.length === 0) {
        infoLog("Admin:Notifications", "Broadcast skipped: no users", { title });
        return NextResponse.json({ success: true, count: 0 });
      }

      const result = await prisma.notification.createMany({
        data: users.map((user) => ({
          userId: user.id,
          type: "admin",
          title,
          message,
          link,
        })),
      });

      infoLog("Admin:Notifications", `Broadcast created count=${result.count}`, { title });
      return NextResponse.json({ success: true, count: result.count });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    await prisma.notification.create({
      data: {
        userId: user.id,
        type: "admin",
        title,
        message,
        link,
      },
    });

    infoLog("Admin:Notifications", `Created for user=${user.id}`, { title });
    return NextResponse.json({ success: true, count: 1 });
  } catch (error) {
    errorLog("Admin:Notifications", "POST failed", error);
    return NextResponse.json({ error: "Ошибка создания уведомления" }, { status: 500 });
  }
}
