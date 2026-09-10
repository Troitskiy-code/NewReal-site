import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensureNotificationTable } from "@/lib/ensureNotificationTable";
import { errorLog } from "@/lib/logger";

export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    await ensureNotificationTable();

    const result = await prisma.notification.updateMany({
      where: { userId: session.user.id, read: false },
      data: { read: true },
    });

    return NextResponse.json({ success: true, count: result.count });
  } catch (error) {
    errorLog("Notifications", "Mark all read failed", error);
    return NextResponse.json({ error: "Ошибка обновления уведомлений" }, { status: 500 });
  }
}
