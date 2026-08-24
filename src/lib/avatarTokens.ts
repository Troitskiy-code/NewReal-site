import { prisma } from "@/lib/prisma";
import { isSameCalendarDay, isSubscriptionActive } from "@/lib/verseChatEconomy";

export const MAX_AVATAR_TOKENS = 10;
export const AVATAR_REPLENISH_HOURS = 6;
export const AVATAR_REPLENISH_MS = AVATAR_REPLENISH_HOURS * 60 * 60 * 1000;
export const FREE_DAILY_LIMIT = 5;
export const SUBSCRIBER_DAILY_LIMIT = 10;

export type AvatarModelType = "FLUX" | "SD";

export type AvatarTokenUser = {
  id: string;
  verseCoins: number;
  avatarTokens: number;
  lastTokenReplenish: Date;
  tokensUsedToday: number;
  lastTokenDate: Date;
  subscriptionType: string | null;
  subscriptionEnd: Date | null;
};

const AVATAR_TOKEN_SELECT = {
  id: true,
  verseCoins: true,
  avatarTokens: true,
  lastTokenReplenish: true,
  tokensUsedToday: true,
  lastTokenDate: true,
  subscriptionType: true,
  subscriptionEnd: true,
} as const;

export function getFreeTokenCost(modelType: AvatarModelType): number {
  return modelType === "SD" ? 2 : 1;
}

export function getPaidVCCost(modelType: AvatarModelType): number {
  return modelType === "SD" ? 25 : 2;
}

export function getDailyLimit(
  user: Pick<AvatarTokenUser, "subscriptionType" | "subscriptionEnd">
): number {
  return isSubscriptionActive(user) ? SUBSCRIBER_DAILY_LIMIT : FREE_DAILY_LIMIT;
}

function normalizeDailyUsage(
  user: Pick<AvatarTokenUser, "tokensUsedToday" | "lastTokenDate">,
  now = new Date()
): { tokensUsedToday: number; lastTokenDate: Date } {
  if (!isSameCalendarDay(user.lastTokenDate, now)) {
    return { tokensUsedToday: 0, lastTokenDate: now };
  }
  return { tokensUsedToday: user.tokensUsedToday, lastTokenDate: user.lastTokenDate };
}

export function canSpendFreeToken(
  user: AvatarTokenUser,
  modelType: AvatarModelType
): { ok: boolean; reason?: string } {
  const daily = normalizeDailyUsage(user);
  const dailyLimit = getDailyLimit(user);
  const cost = getFreeTokenCost(modelType);

  if (daily.tokensUsedToday >= dailyLimit) {
    return { ok: false, reason: "Дневной лимит исчерпан" };
  }
  if (user.avatarTokens < cost) {
    return { ok: false, reason: "Недостаточно AT" };
  }
  return { ok: true };
}

export async function replenishAvatarTokens(userId: string, now = new Date()): Promise<AvatarTokenUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: AVATAR_TOKEN_SELECT,
  });

  if (!user) {
    throw new Error("Пользователь не найден");
  }

  const daily = normalizeDailyUsage(user, now);
  const elapsed = now.getTime() - user.lastTokenReplenish.getTime();
  const periods = Math.max(0, Math.floor(elapsed / AVATAR_REPLENISH_MS));
  const nextTokens = Math.min(MAX_AVATAR_TOKENS, user.avatarTokens + periods);
  const nextReplenish =
    periods > 0
      ? new Date(user.lastTokenReplenish.getTime() + periods * AVATAR_REPLENISH_MS)
      : user.lastTokenReplenish;

  if (
    nextTokens === user.avatarTokens &&
    nextReplenish.getTime() === user.lastTokenReplenish.getTime() &&
    daily.tokensUsedToday === user.tokensUsedToday
  ) {
    return user;
  }

  return prisma.user.update({
    where: { id: userId },
    data: {
      avatarTokens: nextTokens,
      lastTokenReplenish: nextReplenish,
      tokensUsedToday: daily.tokensUsedToday,
      lastTokenDate: daily.lastTokenDate,
    },
    select: AVATAR_TOKEN_SELECT,
  });
}

export async function spendFreeToken(
  user: AvatarTokenUser,
  modelType: AvatarModelType
): Promise<AvatarTokenUser> {
  const cost = getFreeTokenCost(modelType);
  const daily = normalizeDailyUsage(user);

  return prisma.user.update({
    where: { id: user.id },
    data: {
      avatarTokens: { decrement: cost },
      tokensUsedToday: daily.tokensUsedToday + 1,
      lastTokenDate: daily.lastTokenDate,
    },
    select: AVATAR_TOKEN_SELECT,
  });
}

export async function chargeAvatarVC(
  userId: string,
  costVC: number,
  modelType: AvatarModelType
): Promise<number> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { verseCoins: { decrement: costVC } },
    select: { verseCoins: true },
  });

  await prisma.transaction.create({
    data: {
      userId,
      amount: -costVC,
      type: "avatar",
      description: `Генерация аватара (${modelType === "SD" ? "SD 3.5 Large" : "FLUX Schnell"})`,
    },
  });

  return updated.verseCoins;
}

export function getAvatarTokenStatus(user: AvatarTokenUser) {
  const daily = normalizeDailyUsage(user);
  const dailyLimit = getDailyLimit(user);

  return {
    avatarTokens: user.avatarTokens,
    maxTokens: MAX_AVATAR_TOKENS,
    tokensUsedToday: daily.tokensUsedToday,
    dailyLimit,
    dailyRemaining: Math.max(0, dailyLimit - daily.tokensUsedToday),
    verseCoins: user.verseCoins,
    fluxCostAT: getFreeTokenCost("FLUX"),
    sdCostAT: getFreeTokenCost("SD"),
    fluxCostVC: getPaidVCCost("FLUX"),
    sdCostVC: getPaidVCCost("SD"),
  };
}
