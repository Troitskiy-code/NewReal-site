import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  applyBonusMultiplier,
  getBonusForStreak,
  getMsUntilNextDay,
  getNextBonus,
  getUpcomingBonusStreak,
  isPreviousCalendarDay,
  isSameCalendarDay,
} from "@/lib/dailyBonus";
import { normalizeUserCounters, DAILY_REQUEST_LIMIT } from "@/lib/verseChatEconomy";
import { replenishAvatarTokens } from "@/lib/avatarTokens";
import { activatePendingSubscriptionIfNeeded } from "@/lib/subscription";
import { serializeSubscriptionState } from "@/lib/subscriptionState";
import { serializeCoinBalances } from "@/lib/verseCoins";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        verseCoins: true,
        permanentCoins: true,
        bonusStreak: true,
        lastBonusDate: true,
        subscriptionType: true,
        subscriptionEnd: true,
        pendingSubscriptionType: true,
        pendingSubscriptionEnd: true,
        isSubscribed: true,
        robokassaRecurringId: true,
        dailyRequests: true,
        dailyRequestsDate: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    await replenishAvatarTokens(session.user.id);
    const activated = await activatePendingSubscriptionIfNeeded(user);
    const synced = activated
      ? (await prisma.user.findUnique({
          where: { id: session.user.id },
          select: {
            subscriptionType: true,
            subscriptionEnd: true,
            pendingSubscriptionType: true,
            pendingSubscriptionEnd: true,
            isSubscribed: true,
            robokassaRecurringId: true,
            verseCoins: true,
            permanentCoins: true,
          },
        })) ?? user
      : user;
    const subscription = serializeSubscriptionState(
      {
        subscriptionType: synced.subscriptionType,
        subscriptionEnd: synced.subscriptionEnd,
        pendingSubscriptionType: synced.pendingSubscriptionType,
        pendingSubscriptionEnd: synced.pendingSubscriptionEnd,
        isSubscribed: synced.isSubscribed,
        robokassaRecurringId: synced.robokassaRecurringId,
      }
    );

    const now = new Date();
    const coins = serializeCoinBalances({
      verseCoins: synced.verseCoins ?? user.verseCoins,
      permanentCoins: synced.permanentCoins ?? user.permanentCoins,
    });
    const skippedBonusDay = Boolean(
      user.lastBonusDate &&
        !isSameCalendarDay(user.lastBonusDate, now) &&
        !isPreviousCalendarDay(user.lastBonusDate, now)
    );
    const bonusStreakForPreview = skippedBonusDay ? 0 : user.bonusStreak;
    const claimedToday = Boolean(user.lastBonusDate && isSameCalendarDay(user.lastBonusDate, now));
    const canClaimBonus = !claimedToday;
    const bonusSubscriptionType = subscription.subscriptionActive ? subscription.subscriptionType : null;
    const upcomingStreak = skippedBonusDay ? 1 : getUpcomingBonusStreak(user.bonusStreak);
    const currentBonusAmount = applyBonusMultiplier(
      getBonusForStreak(upcomingStreak),
      bonusSubscriptionType
    );
    const counters = normalizeUserCounters(
      {
        id: session.user.id,
        verseCoins: coins.verseCoins,
        subscriptionType: subscription.subscriptionType,
        subscriptionEnd: subscription.subscriptionEnd,
        dailyRequests: user.dailyRequests,
        dailyRequestsDate: user.dailyRequestsDate,
      },
      now
    );

    return NextResponse.json({
      ...coins,
      bonusStreak: user.bonusStreak,
      lastBonusDate: user.lastBonusDate,
      canClaimBonus,
      currentBonusAmount,
      nextBonus: applyBonusMultiplier(getNextBonus(bonusStreakForPreview), bonusSubscriptionType),
      msUntilNextBonus: claimedToday ? getMsUntilNextDay(now) : 0,
      ...subscription,
      robokassaRecurringId: synced.robokassaRecurringId ?? null,
      dailyRequests: counters.dailyRequests,
      dailyRequestsDate: counters.dailyRequestsDate,
      dailyLimit: DAILY_REQUEST_LIMIT,
      dailyRequestsRemaining: Math.max(0, DAILY_REQUEST_LIMIT - counters.dailyRequests),
    });
  } catch (error) {
    console.error("Balance fetch error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
