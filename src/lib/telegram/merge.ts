import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { SIGNUP_VC_GRANT } from "@/lib/provisionNewUser";
import { createThreadInTransaction, threadPromptScopeKey } from "@/lib/chatThreads";

// A content transfer is deliberately narrower than moving payment contracts or login credentials.
// Both accounts are proven (website session + explicit confirmation by the Telegram owner).
export const MERGE_QUIET_MS = 3 * 60_000;

export async function telegramMergePreview(tx: Prisma.TransactionClient, sourceId: string, targetId: string) {
  const source = await tx.user.findUnique({ where: { id: sourceId }, include: {
    _count: { select: { accounts: true, sessions: true, characters: true, chatThreads: true, messages: true,
      personas: true, favorites: true, memories: true, coreMemories: true, episodicMemories: true, memoryEntries: true,
      notifications: true, creations: true, instances: true, supportTickets: true, transactions: true,
      avatarQuotaReservations: true, characterGenerationBatches: true } },
  } });
  if (!source || source.email || source.password || source.customApiKey || source._count.accounts || source._count.sessions
    || source.subscriptionType !== "start" || source.subscriptionEnd || source.pendingSubscriptionType
    || source.pendingSubscriptionEnd || source.robokassaRecurringId || source.isSubscribed
    || source.credits !== 0 || source.verseCoins !== source.permanentCoins || source.permanentCoins < 0) {
    return { status: "unsupported" as const };
  }
  const [payments, orders, purchases, activeAvatars, batches, recentMessages, target, spending] = await Promise.all([
    tx.paymentEvent.count({ where: { userId: sourceId } }), tx.paymentOrder.count({ where: { userId: sourceId } }),
    tx.firstVcPurchase.count({ where: { userId: sourceId } }),
    tx.avatarGeneration.count({ where: { userId: sourceId, state: { notIn: ["succeeded", "failed", "completed", "cancelled"] } } }),
    tx.characterGenerationBatch.count({ where: { ownerId: sourceId, state: "running" } }),
    tx.message.count({ where: { userId: sourceId, createdAt: { gt: new Date(Date.now() - MERGE_QUIET_MS) } } }),
    tx.user.findUnique({ where: { id: targetId }, select: { referredBy: true, referralCode: true } }),
    tx.transaction.aggregate({ where: { userId: sourceId, type: "chat", amount: { lt: 0 } }, _sum: { amount: true } }),
  ]);
  if (payments || orders || purchases || !target || source.referredBy === targetId || target.referredBy === sourceId
    || (source.referralCode && target.referralCode)) {
    return { status: "unsupported" as const };
  }
  if (activeAvatars || batches || recentMessages || source.lastSeen.getTime() > Date.now() - MERGE_QUIET_MS) {
    return { status: "busy" as const };
  }
  // Starter coins are spent first. Only their unspent remainder is excluded: earned coins must
  // survive even when the total balance has fallen below 50 after previous conversations.
  const spentVC = Math.max(0, -(spending._sum.amount ?? 0));
  const starterRemaining = Math.min(source.permanentCoins, Math.max(0, SIGNUP_VC_GRANT - spentVC));
  const transferableVC = source.permanentCoins - starterRemaining;
  const fingerprint = createHash("sha256").update(JSON.stringify({
    sourceId, targetId, counts: source._count, vc: source.verseCoins, realCoins: source.realCoins,
    bonus: source.lastBonusDate, daily: source.lastDailyBonus, avatar: source.avatarTokens,
    used: source.tokensUsedThisMonth, requests: source.dailyRequests, lastSeen: source.lastSeen, transferableVC,
  })).digest("hex");
  return { status: "ready" as const, source, transferableVC, fingerprint };
}

export async function mergeTelegramProfile(tx: Prisma.TransactionClient, sourceId: string, targetId: string) {
  const preview = await telegramMergePreview(tx, sourceId, targetId);
  if (preview.status !== "ready") return preview.status;
  const source = preview.source;
  const target = await tx.user.findUniqueOrThrow({ where: { id: targetId } });

  // Assign unbackfilled messages to their own story before changing owner. Never mix two histories.
  const legacy = await tx.message.findMany({ where: { userId: sourceId, threadId: null }, distinct: ["characterId"], select: { characterId: true } });
  for (const { characterId } of legacy) {
    const thread = await createThreadInTransaction(tx, { userId: sourceId, characterId, title: "Telegram" });
    await tx.message.updateMany({ where: { userId: sourceId, characterId, threadId: null }, data: { threadId: thread.id } });
    for (const table of ["Memory", "CoreMemory", "EpisodicMemory", "MemoryEntry"] as const) {
      await tx.$executeRawUnsafe(`UPDATE "${table}" SET "threadId"=$1 WHERE "userId"=$2 AND "characterId"=$3 AND "threadId" IS NULL`, thread.id, sourceId, characterId);
    }
    const state = await tx.chatPromptState.findUnique({ where: { scopeKey_characterId: { scopeKey: `user:${sourceId}`, characterId } } });
    if (state) await tx.chatPromptState.update({ where: { id: state.id }, data: { scopeKey: threadPromptScopeKey(thread.id) } });
  }
  const stories = await tx.chatThread.findMany({ where: { userId: sourceId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  for (const story of stories) {
    const last = await tx.chatThread.aggregate({ where: { userId: targetId, characterId: story.characterId }, _max: { number: true } });
    await tx.chatThread.update({ where: { id: story.id }, data: { userId: targetId, number: (last._max.number ?? 0) + 1 } });
  }
  const favorites = await tx.favorite.findMany({ where: { userId: sourceId } });
  for (const item of favorites) await tx.favorite.upsert({ where: { userId_characterId: { userId: targetId, characterId: item.characterId } },
    create: { ...item, userId: targetId }, update: {} });
  await tx.favorite.deleteMany({ where: { userId: sourceId } });
  const selections = await tx.personaSelection.findMany({ where: { userId: sourceId } });
  for (const item of selections) await tx.personaSelection.upsert({ where: { userId_characterId: { userId: targetId, characterId: item.characterId } },
    create: { userId: targetId, characterId: item.characterId, personaId: item.personaId, createdAt: item.createdAt }, update: {} });
  await tx.personaSelection.deleteMany({ where: { userId: sourceId } });

  // Fixed identifier allowlist; all user values are bound parameters. Stable ids preserve embeddings,
  // memory, prompt settings and character URLs. Financial/audit records stay on the original User.
  for (const table of ["Character", "Message", "Memory", "CoreMemory", "EpisodicMemory", "MemoryEntry", "Persona", "Notification", "AppInstance", "Creation", "SupportTicket", "AvatarQuotaReservation"] as const) {
    await tx.$executeRawUnsafe(`UPDATE "${table}" SET "userId"=$1 WHERE "userId"=$2`, targetId, sourceId);
  }
  // Request keys are per-user. Prefixing the moved keys avoids collisions and prevents stale replay.
  await tx.$executeRaw`UPDATE "AvatarGeneration" SET "userId"=${targetId}, "clientKey"=${`merged:${sourceId}:`} || "clientKey" WHERE "userId"=${sourceId}`;
  await tx.$executeRaw`UPDATE "CharacterGenerationBatch" SET "ownerId"=${targetId}, "clientKey"=${`merged:${sourceId}:`} || "clientKey" WHERE "ownerId"=${sourceId}`;
  await tx.user.updateMany({ where: { referredBy: sourceId, id: { not: targetId } }, data: { referredBy: targetId } });

  const later = (a: Date | null, b: Date | null) => !a ? b : !b ? a : a > b ? a : b;
  const sameDay = source.dailyRequestsDate.toISOString().slice(0, 10) === target.dailyRequestsDate.toISOString().slice(0, 10);
  const sameMonth = source.lastTokenMonth.toISOString().slice(0, 7) === target.lastTokenMonth.toISOString().slice(0, 7);
  if (source.referralCode) await tx.user.update({ where: { id: sourceId }, data: { referralCode: null } });
  await tx.user.update({ where: { id: targetId }, data: {
    verseCoins: { increment: preview.transferableVC }, permanentCoins: { increment: preview.transferableVC },
    realCoins: { increment: source.realCoins },
    avatarTokens: Math.max(0, target.avatarTokens - Math.max(0, 10 - source.avatarTokens)),
    tokensUsedThisMonth: sameMonth ? source.tokensUsedThisMonth + target.tokensUsedThisMonth
      : source.lastTokenMonth > target.lastTokenMonth ? source.tokensUsedThisMonth : target.tokensUsedThisMonth,
    lastTokenMonth: later(source.lastTokenMonth, target.lastTokenMonth)!,
    lastTokenReplenish: later(source.lastTokenReplenish, target.lastTokenReplenish)!,
    ...(source.referralCode ? { referralCode: source.referralCode } : {}),
    dailyRequests: sameDay ? source.dailyRequests + target.dailyRequests : (source.dailyRequestsDate > target.dailyRequestsDate ? source.dailyRequests : target.dailyRequests),
    dailyRequestsDate: later(source.dailyRequestsDate, target.dailyRequestsDate)!,
    lastBonusDate: later(source.lastBonusDate, target.lastBonusDate), lastDailyBonus: later(source.lastDailyBonus, target.lastDailyBonus),
    bonusStreak: source.lastBonusDate && (!target.lastBonusDate || source.lastBonusDate > target.lastBonusDate) ? source.bonusStreak : target.bonusStreak,
  } });
  // Retain both User rows and original accounting history; the orphan has no usable login.
  await tx.user.update({ where: { id: sourceId }, data: { verseCoins: 0, permanentCoins: 0, realCoins: 0, avatarTokens: 0 } });
  await tx.transaction.createMany({ data: [
    { userId: sourceId, amount: -source.verseCoins, type: "telegram_merge_out", description: `Telegram profile merged into ${targetId}; duplicate signup VC excluded` },
    { userId: targetId, amount: preview.transferableVC, type: "telegram_merge_in", description: `Telegram profile data and earned VC transferred from ${sourceId}` },
  ] });
  if (source.realCoins) await tx.transaction.createMany({ data: [
    { userId: sourceId, amount: -source.realCoins, type: "telegram_merge_real_out", description: `Referral balance transferred to ${targetId}` },
    { userId: targetId, amount: source.realCoins, type: "telegram_merge_real_in", description: `Referral balance transferred from ${sourceId}` },
  ] });
  await tx.telegramLinkToken.deleteMany({ where: { userId: sourceId } });
  await tx.passwordResetToken.deleteMany({ where: { userId: sourceId } });
  await tx.emailVerificationToken.deleteMany({ where: { userId: sourceId } });
  return "merged" as const;
}
