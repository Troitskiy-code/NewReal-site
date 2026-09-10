import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensureNotificationTable } from "@/lib/ensureNotificationTable";
import { errorLog } from "@/lib/logger";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const body = await req.json();
    const notificationIds = Array.isArray(body?.notificationIds)
      ? body.notificationIds.filter((id: unknown) => typeof id === "string" && id.trim())
      : [];

    if (notificationIds.length === 0) {
      return NextResponse.json({ error: "notificationIds обязателен" }, { status: 400 });
    }

    await ensureNotificationTable();

    const result = await prisma.notification.updateMany({
      where: {
        id: { in: notificationIds },
        userId: session.user.id,
      },
      data: { read: true },
    });

    return NextResponse.json({ success: true, count: result.count });
  } catch (error) {
    errorLog("Notifications", "Mark read failed", error);
    return NextResponse.json({ error: "Ошибка обновления уведомлений" }, { status: 500 });
  }
}
