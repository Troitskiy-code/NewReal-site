import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getBonusForStreak,
  getMsUntilNextDay,
  getNextBonus,
  getNextStreak,
  getSubscriptionLabel,
  getUpcomingBonusStreak,
  isSameCalendarDay,
} from "@/lib/dailyBonus";
import { FREE_TIER_MONTHLY_LIMIT, isSubscriptionActive, normalizeUserCounters, DAILY_REQUEST_LIMIT } from "@/lib/verseChatEconomy";

export async function GET() {
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
        freeRequestsUsed: true,
        freeRequestsMonth: true,
        dailyRequests: true,
        dailyRequestsDate: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    const now = new Date();
    const claimedToday = Boolean(user.lastBonusDate && isSameCalendarDay(user.lastBonusDate, now));
    const canClaimBonus = !claimedToday;
    const upcomingStreak = getUpcomingBonusStreak(user.bonusStreak);
    const currentBonusAmount = getBonusForStreak(upcomingStreak);
    const counters = normalizeUserCounters(
      {
        id: session.user.id,
        verseCoins: user.verseCoins,
        subscriptionType: user.subscriptionType,
        subscriptionEnd: user.subscriptionEnd,
        freeRequestsUsed: user.freeRequestsUsed,
        freeRequestsMonth: user.freeRequestsMonth,
        dailyRequests: user.dailyRequests,
        dailyRequestsDate: user.dailyRequestsDate,
      },
      now
    );
    const subscriptionActive = isSubscriptionActive(user);

    return NextResponse.json({
      verseCoins: user.verseCoins,
      bonusStreak: user.bonusStreak,
      lastBonusDate: user.lastBonusDate,
      canClaimBonus,
      currentBonusAmount,
      nextBonus: getNextBonus(user.bonusStreak),
      msUntilNextBonus: claimedToday ? getMsUntilNextDay(now) : 0,
      subscriptionType: user.subscriptionType,
      subscriptionEnd: user.subscriptionEnd,
      subscriptionActive,
      subscriptionLabel: subscriptionActive ? getSubscriptionLabel(user.subscriptionType) : null,
      freeRequestsUsed: counters.freeRequestsUsed,
      freeRequestsRemaining: subscriptionActive
        ? null
        : Math.max(0, FREE_TIER_MONTHLY_LIMIT - counters.freeRequestsUsed),
      freeRequestsLimit: FREE_TIER_MONTHLY_LIMIT,
      dailyRequests: counters.dailyRequests,
      dailyRequestsDate: counters.dailyRequestsDate,
      freeRequestsMonth: counters.freeRequestsMonth,
      dailyLimit: DAILY_REQUEST_LIMIT,
      dailyRequestsRemaining: Math.max(0, DAILY_REQUEST_LIMIT - counters.dailyRequests),
    });
  } catch (error) {
    console.error("Balance fetch error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
