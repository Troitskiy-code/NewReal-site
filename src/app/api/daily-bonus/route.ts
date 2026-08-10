import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const BONUS_AMOUNT = 50;
const BONUS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function getMsUntilNextBonus(lastDailyBonus: Date | null): number {
  if (!lastDailyBonus) return 0;
  const nextAt = lastDailyBonus.getTime() + BONUS_COOLDOWN_MS;
  return Math.max(0, nextAt - Date.now());
}

function canClaimBonus(lastDailyBonus: Date | null): boolean {
  if (!lastDailyBonus) return true;
  return Date.now() - lastDailyBonus.getTime() >= BONUS_COOLDOWN_MS;
}

export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { realCoins: true, lastDailyBonus: true },
    });

    if (!user) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    if (!canClaimBonus(user.lastDailyBonus)) {
      const msUntilNextBonus = getMsUntilNextBonus(user.lastDailyBonus);
      const nextBonusAt = user.lastDailyBonus
        ? new Date(user.lastDailyBonus.getTime() + BONUS_COOLDOWN_MS)
        : null;

      return NextResponse.json(
        {
          error: "Приходите завтра",
          msUntilNextBonus,
          nextBonusAt,
        },
        { status: 400 }
      );
    }

    const updatedUser = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        realCoins: { increment: BONUS_AMOUNT },
        lastDailyBonus: new Date(),
      },
      select: { realCoins: true, lastDailyBonus: true },
    });

    return NextResponse.json({
      realCoins: updatedUser.realCoins,
      lastDailyBonus: updatedUser.lastDailyBonus,
      message: "Бонус получен!",
    });
  } catch (error) {
    console.error("Daily bonus error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
