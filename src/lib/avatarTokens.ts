import { prisma } from "@/lib/prisma";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";
import { avatarMonthlyAllowance } from "./avatarEconomy";
import { randomUUID } from "node:crypto";

export const MAX_AVATAR_TOKENS = 10;
export const AVATAR_REPLENISH_HOURS = 6;
export const AVATAR_REPLENISH_MS = AVATAR_REPLENISH_HOURS * 60 * 60 * 1000;

export const MONTHLY_LIMITS = {
  free: 0,
  dialog: avatarMonthlyAllowance("dialog"),
  history: avatarMonthlyAllowance("story"),
  universe: avatarMonthlyAllowance("universe"),
} as const;

export type AvatarModelType = "FLUX" | "SD";

export type AvatarTokenUser = {
  id: string;
  verseCoins: number;
  avatarTokens: number;
  lastTokenReplenish: Date;
  tokensUsedThisMonth: number;
  lastTokenMonth: Date;
  subscriptionType: string | null;
  subscriptionEnd: Date | null;
};

const AVATAR_TOKEN_SELECT = {
  id: true,
  verseCoins: true,
  avatarTokens: true,
  lastTokenReplenish: true,
  tokensUsedThisMonth: true,
  lastTokenMonth: true,
  subscriptionType: true,
  subscriptionEnd: true,
} as const;

export function getMonthlyLimit(
  user: Pick<AvatarTokenUser, "subscriptionType" | "subscriptionEnd">
): number {
  if (!isSubscriptionActive(user)) {
    return MONTHLY_LIMITS.free;
  }

  const type = (user.subscriptionType ?? "free").trim().toLowerCase();
  if (type === "dialog") return MONTHLY_LIMITS.dialog;
  if (type === "history" || type === "story") return MONTHLY_LIMITS.history;
  if (type === "universe") return MONTHLY_LIMITS.universe;
  return MONTHLY_LIMITS.free;
}

function isSameCalendarMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function normalizeMonthlyUsage(
  user: Pick<AvatarTokenUser, "tokensUsedThisMonth" | "lastTokenMonth">,
  now = new Date()
): { tokensUsedThisMonth: number; lastTokenMonth: Date } {
  if (!isSameCalendarMonth(user.lastTokenMonth, now)) {
    return { tokensUsedThisMonth: 0, lastTokenMonth: now };
  }
  return { tokensUsedThisMonth: user.tokensUsedThisMonth, lastTokenMonth: user.lastTokenMonth };
}

export function canGenerateThisMonth(user: AvatarTokenUser): { ok: boolean; reason?: string } {
  const monthly = normalizeMonthlyUsage(user);
  const monthlyLimit = getMonthlyLimit(user);

  if (monthly.tokensUsedThisMonth + 1 > monthlyLimit) {
    return { ok: false, reason: "Достигнут месячный лимит бесплатных генераций" };
  }
  return { ok: true };
}

export async function getAvatarUsageUser(userId: string, now = new Date()): Promise<AvatarTokenUser> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: AVATAR_TOKEN_SELECT,
    });

    if (!user) {
      throw new Error("Пользователь не найден");
    }

    const monthly = normalizeMonthlyUsage(user, now);
    if (
      monthly.tokensUsedThisMonth === user.tokensUsedThisMonth &&
      monthly.lastTokenMonth.getTime() === user.lastTokenMonth.getTime()
    ) {
      return user;
    }

    return tx.user.update({
      where: { id: userId },
      data: {
        tokensUsedThisMonth: monthly.tokensUsedThisMonth,
        lastTokenMonth: monthly.lastTokenMonth,
      },
      select: AVATAR_TOKEN_SELECT,
    });
  });
}

export async function replenishAvatarTokens(userId: string, now = new Date()): Promise<AvatarTokenUser> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: AVATAR_TOKEN_SELECT,
    });

    if (!user) {
      throw new Error("Пользователь не найден");
    }

    const monthly = normalizeMonthlyUsage(user, now);
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
      monthly.tokensUsedThisMonth === user.tokensUsedThisMonth
    ) {
      return user;
    }

    return tx.user.update({
      where: { id: userId },
      data: {
        avatarTokens: nextTokens,
        lastTokenReplenish: nextReplenish,
        tokensUsedThisMonth: monthly.tokensUsedThisMonth,
        lastTokenMonth: monthly.lastTokenMonth,
      },
      select: AVATAR_TOKEN_SELECT,
    });
  });
}

export function getAvatarTokenStatus(user: AvatarTokenUser) {
  const monthly = normalizeMonthlyUsage(user);
  const monthlyLimit = getMonthlyLimit(user);

  return {
    tokensUsedThisMonth: monthly.tokensUsedThisMonth,
    monthlyLimit,
    monthlyRemaining: Math.max(0, monthlyLimit - monthly.tokensUsedThisMonth),
  };
}

export async function reserveAvatarGeneration(userId: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: AVATAR_TOKEN_SELECT });
    if (!user) throw new Error("Пользователь не найден");
    if (!canGenerateThisMonth(user).ok) return null;
    const monthly = normalizeMonthlyUsage(user);
    const id = randomUUID();
    await tx.avatarQuotaReservation.create({ data: { id, userId, units: 1, month: monthly.lastTokenMonth } });
    const updated = await tx.user.update({ where: { id: userId }, data: {
      tokensUsedThisMonth: monthly.tokensUsedThisMonth + 1, lastTokenMonth: monthly.lastTokenMonth,
    }, select: AVATAR_TOKEN_SELECT });
    return { id, user: updated };
  });
}

export async function settleAvatarGeneration(id: string, succeeded: boolean | "review") {
  return prisma.$transaction(async tx => {
    const reservation = await tx.avatarQuotaReservation.findUnique({ where: { id } });
    if (!reservation || reservation.status !== "reserved") return;
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${reservation.userId} FOR UPDATE`;
    const claimed = await tx.avatarQuotaReservation.updateMany({ where: { id, status: "reserved" }, data: { status: succeeded === "review" ? "manual_review" : succeeded ? "completed" : "refunded" } });
    if (!claimed.count || succeeded) return;
    // Activation or month rollover may have reset usage: never refund into that new period.
    await tx.user.updateMany({ where: { id: reservation.userId, lastTokenMonth: reservation.month,
      tokensUsedThisMonth: { gte: reservation.units } }, data: { tokensUsedThisMonth: { decrement: reservation.units } } });
  });
}
