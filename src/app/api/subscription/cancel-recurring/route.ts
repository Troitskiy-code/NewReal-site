import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { cancelRobokassaRecurring } from "@/lib/robokassa";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { serializeSubscriptionState, SUBSCRIPTION_SELECT } from "@/lib/subscriptionState";

export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });

    const stopped = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId }, select: SUBSCRIPTION_SELECT });
      if (!user) return null;
      const recurringId = user.robokassaRecurringId;
      if (recurringId) {
        await tx.user.update({ where: { id: userId }, data: { robokassaRecurringId: null } });
        await tx.transaction.create({ data: { userId, amount: 0, type: "subscription_cancelled",
          description: "Автопродление отключено" } });
      }
      return { user: { ...user, robokassaRecurringId: null }, recurringId };
    });
    if (!stopped) return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });

    if (stopped.recurringId) await cancelRobokassaRecurring(stopped.recurringId);
    return NextResponse.json({
      success: true,
      message: "Автопродление отключено",
      ...serializeSubscriptionState(stopped.user),
    });
  } catch (error) {
    errorLog("Subscription", "cancel-recurring", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось отключить автопродление" }, { status: 500 });
  }
}
