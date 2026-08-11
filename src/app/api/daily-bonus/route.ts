import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const BONUS_AMOUNTS = [10, 15, 20, 25, 30, 35, 40];

function startOfDay(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

function getMsUntilNextDay(now = new Date()): number {
  const nextDay = startOfDay(now);
  nextDay.setDate(nextDay.getDate() + 1);
  return Math.max(0, nextDay.getTime() - now.getTime());
}

function getBonusForStreak(streak: number): number {
  const index = Math.min(Math.max(streak, 1), 7) - 1;
  return BONUS_AMOUNTS[index];
}

function getNextStreak(currentStreak: number): number {
  const nextStreak = currentStreak + 1;
  return nextStreak > 7 ? 1 : nextStreak;
}

function getNextBonus(currentStreak: number): number {
  return getBonusForStreak(getNextStreak(currentStreak));
}

export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        verseCoins: true,
        bonusStreak: true,
        lastBonusDate: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    const now = new Date();
    const msUntilNextBonus = getMsUntilNextDay(now);
    const nextBonusAt = new Date(now.getTime() + msUntilNextBonus);

    if (user.lastBonusDate && isSameCalendarDay(user.lastBonusDate, now)) {
      return NextResponse.json(
        {
          error: "Бонус уже получен сегодня. Приходите завтра!",
          coins: user.verseCoins,
          streak: user.bonusStreak,
          nextBonus: getNextBonus(user.bonusStreak),
          msUntilNextBonus,
          nextBonusAt,
        },
        { status: 400 }
      );
    }

    let newStreak = user.bonusStreak + 1;
    if (newStreak > 7) {
      newStreak = 1;
    }

    const bonus = getBonusForStreak(newStreak);
    const nextBonus = getNextBonus(newStreak);

    const updatedUser = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        verseCoins: { increment: bonus },
        bonusStreak: newStreak,
        lastBonusDate: now,
      },
      select: {
        verseCoins: true,
        bonusStreak: true,
        lastBonusDate: true,
      },
    });

    return NextResponse.json({
      coins: updatedUser.verseCoins,
      streak: updatedUser.bonusStreak,
      nextBonus,
      bonus,
      lastBonusDate: updatedUser.lastBonusDate,
      message: `Бонус +${bonus} VC получен!`,
    });
  } catch (error) {
    console.error("Daily bonus error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
