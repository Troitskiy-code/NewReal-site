import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { serializeSubscriptionState } from "@/lib/subscriptionState";

export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const updated = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        pendingSubscriptionType: null,
        pendingSubscriptionEnd: null,
      },
      select: {
        subscriptionType: true,
        subscriptionEnd: true,
        pendingSubscriptionType: true,
        pendingSubscriptionEnd: true,
        isSubscribed: true,
        robokassaRecurringId: true,
      },
    });

    return NextResponse.json(serializeSubscriptionState(updated));
  } catch (error) {
    errorLog("Subscription", "pending.cancel", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось отменить ожидающую подписку" }, { status: 500 });
  }
}
