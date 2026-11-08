import { prisma } from "@/lib/prisma";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";
import { avatarMonthlyAllowance } from "./avatarEconomy";
import { randomUUID } from "node:crypto";
import { UNCERTAIN_BLOCK_MS } from "./kieAvatarModels";
import type { Prisma } from "@prisma/client";
import { spendCoins, getPermanentCoins } from "./verseCoins";
import { applyPendingSubscriptionIfDue } from "./subscriptionState";
import { STORY_SCENE_PRICE_VC, storySceneThreadId, type StorySceneQuote } from "./storySceneShared";

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
  permanentCoins: number;
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
  permanentCoins: true,
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

type GenerationInput = { clientKey: string; scope: string; payloadHash: string; model: string; estimatedCredits: number; creditRub: number };
export class AvatarRequestConflict extends Error {}
export class StoryScenePriceError extends Error {
  constructor(readonly code: "STORY_SCENE_PRICE_CHANGED" | "STORY_SCENE_INSUFFICIENT_VC", readonly quote: StorySceneQuote) {
    super(code);
  }
}

function sceneQuote(user: Pick<AvatarTokenUser, "verseCoins" | "permanentCoins" | "subscriptionEnd">): StorySceneQuote {
  return { priceVC: STORY_SCENE_PRICE_VC,
    verseCoins: user.subscriptionEnd && user.subscriptionEnd <= new Date() ? getPermanentCoins(user) : user.verseCoins };
}

export async function getStorySceneQuote(userId: string) {
  await applyPendingSubscriptionIfDue(userId);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId },
    select: { verseCoins: true, permanentCoins: true, subscriptionEnd: true } });
  return sceneQuote(user);
}

export async function reserveAvatarGeneration(userId: string, generation?: GenerationInput, acceptedPriceVC?: unknown) {
  const paidScene = Boolean(generation && storySceneThreadId(generation.scope));
  if (paidScene) await applyPendingSubscriptionIfDue(userId);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: AVATAR_TOKEN_SELECT });
    if (!user) throw new Error("Пользователь не найден");
    if (generation) {
      const existing = await tx.avatarGeneration.findUnique({ where: { userId_clientKey: { userId, clientKey: generation.clientKey } } });
      if (existing) {
        if (existing.payloadHash !== generation.payloadHash) throw new AvatarRequestConflict("Avatar idempotency conflict");
        return { id: existing.reservationId, user, generation: existing, isNew: false };
      }
      // Serialize new requests from tabs on the user lock. One outstanding paid run per user.
      const active = await tx.avatarGeneration.findFirst({ where: { userId, OR: [
        { state: { in: ["creating", "pending"] } },
        { state: "uncertain", updatedAt: { gt: new Date(Date.now() - UNCERTAIN_BLOCK_MS) } },
      ] }, orderBy: { createdAt: "desc" } });
      if (active) return { id: active.reservationId, user, generation: active, isNew: false };
    }
    const monthly = normalizeMonthlyUsage(user);
    const id = randomUUID();
    let updated: AvatarTokenUser;
    if (paidScene) {
      const quote = sceneQuote(user);
      if (quote.verseCoins < quote.priceVC) throw new StoryScenePriceError("STORY_SCENE_INSUFFICIENT_VC", quote);
      if (acceptedPriceVC !== quote.priceVC) throw new StoryScenePriceError("STORY_SCENE_PRICE_CHANGED", quote);
      const coins = spendCoins({ verseCoins: quote.verseCoins, permanentCoins: user.permanentCoins }, quote.priceVC);
      await tx.avatarQuotaReservation.create({ data: { id, userId, units: 0, month: monthly.lastTokenMonth,
        chargedVC: quote.priceVC, chargedFromPermanent: user.permanentCoins - coins.permanentCoins,
        chargedSubscriptionEnd: user.subscriptionEnd } });
      updated = await tx.user.update({ where: { id: userId }, data: {
        verseCoins: { decrement: quote.priceVC }, permanentCoins: coins.permanentCoins,
      }, select: AVATAR_TOKEN_SELECT });
      await tx.transaction.create({ data: { userId, amount: -quote.priceVC, type: "story_scene",
        description: "Генерация иллюстрации сцены" } });
    } else {
      if (!canGenerateThisMonth(user).ok) return null;
      await tx.avatarQuotaReservation.create({ data: { id, userId, units: 1, month: monthly.lastTokenMonth } });
      updated = await tx.user.update({ where: { id: userId }, data: {
        tokensUsedThisMonth: monthly.tokensUsedThisMonth + 1, lastTokenMonth: monthly.lastTokenMonth,
      }, select: AVATAR_TOKEN_SELECT });
    }
    const job = generation ? await tx.avatarGeneration.create({ data: {
      id, reservationId: id, userId, ...generation, leaseUntil: new Date(Date.now() + 90_000),
    } }) : null;
    return { id, user: updated, generation: job, isNew: true };
  });
}

export async function settleAvatarGeneration(id: string, succeeded: boolean | "review") {
  return prisma.$transaction(async tx => {
    const reservation = await tx.avatarQuotaReservation.findUnique({ where: { id } });
    if (!reservation || reservation.status !== "reserved") return;
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${reservation.userId} FOR UPDATE`;
    await settleLockedAvatarReservation(tx, id, succeeded);
  });
}

/** Call while holding the user's row lock. */
export async function settleLockedAvatarReservation(tx: Prisma.TransactionClient, id: string, succeeded: boolean | "review") {
  const reservation = await tx.avatarQuotaReservation.findUnique({ where: { id } });
  if (!reservation || !["reserved", "manual_review"].includes(reservation.status)) return;
  await tx.avatarQuotaReservation.update({ where: { id },
    data: { status: succeeded === "review" ? "manual_review" : succeeded ? "completed" : "refunded" } });
  if (succeeded) return;
  if (reservation.chargedVC > 0) {
    const user = await tx.user.findUniqueOrThrow({ where: { id: reservation.userId }, select: { subscriptionEnd: true } });
    const samePeriod = user.subscriptionEnd?.getTime() === reservation.chargedSubscriptionEnd?.getTime()
      && (!user.subscriptionEnd || user.subscriptionEnd > new Date());
    const amount = samePeriod ? reservation.chargedVC : reservation.chargedFromPermanent;
    if (amount > 0) {
      await tx.user.update({ where: { id: reservation.userId }, data: {
        verseCoins: { increment: amount }, permanentCoins: { increment: reservation.chargedFromPermanent },
      } });
      await tx.transaction.create({ data: { userId: reservation.userId, amount, type: "story_scene_refund",
        description: "Возврат за иллюстрацию сцены" } });
    }
    return;
  }
  // Old jobs were paid by the avatar allowance. Only restore units for the original period.
  await tx.user.updateMany({ where: { id: reservation.userId, lastTokenMonth: reservation.month,
    tokensUsedThisMonth: { gte: reservation.units } }, data: { tokensUsedThisMonth: { decrement: reservation.units } } });
}
