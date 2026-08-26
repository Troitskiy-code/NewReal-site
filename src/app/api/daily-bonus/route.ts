import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  applyBonusMultiplier,
  getBonusForStreak,
  getBonusMultiplier,
  getMsUntilNextDay,
  getNextBonus,
  isSameCalendarDay,
} from "@/lib/dailyBonus";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";

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
        subscriptionType: true,
        subscriptionEnd: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    const subscriptionType = isSubscriptionActive(user) ? user.subscriptionType : null;
    const multiplier = getBonusMultiplier(subscriptionType);
    const now = new Date();
    const msUntilNextBonus = getMsUntilNextDay(now);
    const nextBonusAt = new Date(now.getTime() + msUntilNextBonus);

    if (user.lastBonusDate && isSameCalendarDay(user.lastBonusDate, now)) {
      return NextResponse.json(
        {
          error: "Бонус уже получен сегодня. Приходите завтра!",
          coins: user.verseCoins,
          verseCoins: user.verseCoins,
          streak: user.bonusStreak,
          nextBonus: applyBonusMultiplier(getNextBonus(user.bonusStreak), subscriptionType),
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

    const bonus = applyBonusMultiplier(getBonusForStreak(newStreak), subscriptionType);
    const nextBonus = applyBonusMultiplier(getNextBonus(newStreak), subscriptionType);

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

    await prisma.transaction.create({
      data: {
        userId: session.user.id,
        amount: bonus,
        type: "daily_bonus",
        description: `Ежедневный бонус, день ${newStreak}, x${multiplier}`,
      },
    });

    return NextResponse.json({
      coins: updatedUser.verseCoins,
      verseCoins: updatedUser.verseCoins,
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
