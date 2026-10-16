import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { applySignupBenefits, SIGNUP_VC_GRANT } from "@/lib/provisionNewUser";
import { grantReferralBonusIfEligible } from "@/lib/referralBonus";
import { normalizeTelegramReferralCode } from "./shared";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import type { TelegramLaunchUser } from "./initData";
import { mergeTelegramProfile, telegramMergePreview } from "./merge";

export const LINK_TOKEN_TTL_MS = 10 * 60 * 1000;
export const LINK_START_PREFIX = "link_";
export const LINK_CONFIRM_PREFIX = "link_confirm_";
export const MERGE_CONFIRM_PREFIX = "merge_confirm_";

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function displayName(user: TelegramLaunchUser): string | null {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim().slice(0, 64);
  return name || null;
}

export type TelegramSignIn =
  | { status: "ok"; userId: string; accountId: string; isNew: boolean; createdAt: Date }
  | { status: "consent_required" }
  | { status: "login_disabled" };

/**
 * Resolves the NewVerse user of a verified Telegram launch. A new Telegram account gets a new user
 * with the same start VC and plan as a site registration, but only after explicit consent. An
 * unlinked Telegram account stays blocked until it is linked again (no silent second user).
 */
export async function resolveTelegramUser(
  launch: TelegramLaunchUser,
  { consent, referralCode }: { consent: boolean; referralCode?: string | null }
): Promise<TelegramSignIn> {
  const existing = await prisma.telegramAccount.findUnique({
    where: { telegramId: launch.id },
    select: { id: true, userId: true, user: { select: { createdAt: true } } },
  });
  if (existing) {
    if (!existing.userId || !existing.user) return { status: "login_disabled" };
    await prisma.telegramAccount.update({ where: { id: existing.id }, data: { lastLoginAt: new Date() } });
    return { status: "ok", userId: existing.userId, accountId: existing.id, isNew: false, createdAt: existing.user.createdAt };
  }
  if (!consent) return { status: "consent_required" };

  const now = new Date();
  let created: { userId: string; accountId: string; createdAt: Date };
  try {
    created = await prisma.$transaction(async (tx) => {
      const code = normalizeTelegramReferralCode(referralCode);
      const referrer = code ? await tx.user.findUnique({ where: { referralCode: code }, select: { id: true } }) : null;
      const user = await tx.user.create({
        data: { name: displayName(launch), acceptedTermsAt: now, acceptedPrivacyAt: now, referredBy: referrer?.id ?? null },
        select: { id: true, createdAt: true },
      });
      const account = await tx.telegramAccount.create({
        data: { telegramId: launch.id, userId: user.id, origin: "telegram", linkedAt: now, lastLoginAt: now },
        select: { id: true },
      });
      return { userId: user.id, accountId: account.id, createdAt: user.createdAt };
    });
  } catch (error) {
    // A parallel launch of the same Telegram account won the race: use its user.
    if (isUniqueViolation(error)) return resolveTelegramUser(launch, { consent: false });
    throw error;
  }
  try {
    await applySignupBenefits(created.userId);
  } catch (error) {
    errorLog("Telegram", "signup benefits failed", { userId: created.userId, ...toSafeDiagnostic(error) });
  }
  try {
    await grantReferralBonusIfEligible(created.userId, { allowTelegramIdentity: true });
  } catch (error) {
    errorLog("Telegram", "referral bonus failed", { userId: created.userId, ...toSafeDiagnostic(error) });
  }
  infoLog("Telegram", "user created", { userId: created.userId });
  return { status: "ok", userId: created.userId, accountId: created.accountId, isNew: true, createdAt: created.createdAt };
}

/** One-time use of a signed initData. false means it was already used (replay). */
export async function consumeInitDataReceipt(replayKey: string, ttlSeconds: number): Promise<boolean> {
  const now = new Date();
  try {
    await prisma.telegramInitDataReceipt.create({
      // Kept a little longer than initData stays valid, so an expired one cannot be replayed either.
      data: { hash: replayKey, expiresAt: new Date(now.getTime() + (ttlSeconds + 120) * 1000) },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
  await prisma.telegramInitDataReceipt.deleteMany({ where: { expiresAt: { lt: now } } }).catch(() => undefined);
  return true;
}

/** "none": never seen, "unlinked": sign-in disabled until a new link, "linked": has a user. */
export async function telegramAccountState(
  telegramId: string
): Promise<{ state: "none" } | { state: "unlinked" } | { state: "linked"; userId: string }> {
  const account = await prisma.telegramAccount.findUnique({ where: { telegramId }, select: { userId: true } });
  if (!account) return { state: "none" };
  return account.userId ? { state: "linked", userId: account.userId } : { state: "unlinked" };
}

function hashLinkToken(token: string): string {
  return createHash("sha256").update(`tg-link:${token}`).digest("hex");
}

/** New one-time link token; earlier unused tokens of the user stop working. */
export async function createLinkToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);
  await prisma.$transaction([
    prisma.telegramLinkToken.deleteMany({ where: { userId, usedAt: null } }),
    prisma.verificationToken.deleteMany({ where: { token: { startsWith: "tg-merge:" }, expires: { lt: new Date() } } }),
    prisma.telegramLinkToken.create({ data: { tokenHash: hashLinkToken(token), userId, expiresAt } }),
  ]);
  return { token, expiresAt };
}

export type LinkResult = "linked" | "already_linked" | "invalid" | "telegram_taken" | "user_has_other_telegram"
  | "confirmation_required" | "profile_not_empty" | "merge_confirmation_required" | "merge_busy" | "merged";
type LinkDecision = { result: LinkResult; confirmationToken?: string; siteLabel?: string; mergeSummary?: { characters: number; stories: number; messages: number; vc: number } };
type LinkAccount = { id: string; userId: string | null; origin: string };

// Only an unused Mini App registration can be replaced. Keep its User and signup ledger intact;
// neither starter VC nor other benefits are copied to the destination account.
async function isUnusedTelegramProfile(tx: Prisma.TransactionClient, account: LinkAccount): Promise<boolean> {
  if (account.origin !== "telegram" || !account.userId) return false;
  const user = await tx.user.findUnique({
    where: { id: account.userId },
    include: {
      firstVcPurchase: true,
      transactions: true,
      _count: { select: {
        accounts: true, sessions: true, creations: true, instances: true, characters: true, messages: true,
        favorites: true, memories: true, coreMemories: true, episodicMemories: true, memoryEntries: true,
        personas: true, personaSelections: true, chatThreads: true, notifications: true,
        passwordResetTokens: true, emailVerificationTokens: true, supportTickets: true,
        avatarQuotaReservations: true, characterGenerationBatches: true, telegramLinkTokens: true,
      } },
    },
  });
  if (!user || user.email || user.password || user.customApiKey || user.firstVcPurchase
    || user.subscriptionType !== "start" || user.subscriptionEnd || user.pendingSubscriptionType
    || user.pendingSubscriptionEnd || user.robokassaRecurringId || user.isSubscribed
    || user.verseCoins !== SIGNUP_VC_GRANT || user.permanentCoins !== SIGNUP_VC_GRANT
    || user.realCoins !== 0 || user.credits !== 0 || user.avatarTokens !== 10 || user.tokensUsedThisMonth !== 0
    || user.bonusStreak !== 0 || user.lastBonusDate || user.lastDailyBonus || user.dailyRequests !== 0
    || Object.values(user._count).some((count) => count !== 0)
    || user.transactions.length !== 1 || user.transactions[0].type !== "signup_bonus"
    || user.transactions[0].amount !== SIGNUP_VC_GRANT) return false;
  const [payments, orders, referrals] = await Promise.all([
    tx.paymentEvent.count({ where: { userId: user.id } }),
    tx.paymentOrder.count({ where: { userId: user.id } }),
    tx.user.count({ where: { referredBy: user.id } }),
  ]);
  return payments === 0 && orders === 0 && referrals === 0;
}

function confirmationHash(token: string, telegramId: string, accountId: string): string {
  return hashLinkToken(`confirm:${telegramId}:${accountId}:${token}`);
}

function siteAccountLabel(user: { name: string | null; email: string | null }): string {
  const name = user.name?.replace(/[\r\n\t]/g, " ").trim().slice(0, 64);
  const [local, domain] = user.email?.split("@") ?? [];
  const email = local && domain ? `${local.slice(0, 2)}***@${domain}` : null;
  return [name, email].filter(Boolean).join(" · ") || "NewVerse";
}

/**
 * Consumes link_<token> from the bot. The token is single-use (an atomic update marks it used
 * before anything else), bound to the user that created it and short-lived. A Telegram account
 * that already belongs to another user requires a second, Telegram-bound confirmation, and only
 * an unused registration is replaced directly. Eligible populated Telegram-only profiles instead
 * require a separate merge confirmation. Existing independent site accounts are never moved.
 */
export async function consumeLinkToken(token: string, telegramId: string): Promise<LinkDecision> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token) || !/^[1-9]\d{0,19}$/.test(telegramId)) return { result: "invalid" };
  const tokenHash = hashLinkToken(token);
  const now = new Date();
  const claimed = await prisma.telegramLinkToken.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) return { result: "invalid" };
  const row = await prisma.telegramLinkToken.findUnique({ where: { tokenHash }, select: { userId: true } });
  if (!row) return { result: "invalid" };
  try {
    return await prisma.$transaction(async (tx) => {
      const [byTelegram, byUser] = await Promise.all([
        tx.telegramAccount.findUnique({ where: { telegramId }, select: { id: true, userId: true, origin: true } }),
        tx.telegramAccount.findUnique({ where: { userId: row.userId }, select: { id: true, telegramId: true } }),
      ]);
      if (byTelegram?.userId === row.userId) return { result: "already_linked" as const };
      if (byUser && byUser.telegramId !== telegramId) return { result: "user_has_other_telegram" as const };
      if (byTelegram?.userId) {
        if (byTelegram.origin !== "telegram") return { result: "telegram_taken" as const };
        const unused = await isUnusedTelegramProfile(tx, byTelegram);
        const merge = unused ? null : await telegramMergePreview(tx, byTelegram.userId, row.userId);
        if (merge?.status === "busy") return { result: "merge_busy" as const };
        if (merge && merge.status !== "ready") return { result: "profile_not_empty" as const };
        const target = await tx.user.findUnique({ where: { id: row.userId }, select: { name: true, email: true } });
        if (!target) return { result: "invalid" as const };
        const confirmationToken = randomBytes(24).toString("base64url");
        const source = await tx.telegramLinkToken.findUnique({ where: { tokenHash }, select: { expiresAt: true } });
        if (!source || source.expiresAt <= new Date()) return { result: "invalid" as const };
        const pendingHash = merge?.status === "ready"
          ? hashLinkToken(`merge:${telegramId}:${byTelegram.id}:${confirmationToken}`)
          : confirmationHash(confirmationToken, telegramId, byTelegram.id);
        await tx.telegramLinkToken.create({ data: {
          tokenHash: pendingHash,
          userId: row.userId, expiresAt: source.expiresAt,
        } });
        if (merge?.status === "ready") {
          await tx.verificationToken.create({ data: { token: `tg-merge:${pendingHash}`, identifier: merge.fingerprint, expires: source.expiresAt } });
          return { result: "merge_confirmation_required" as const, confirmationToken, siteLabel: siteAccountLabel(target),
            mergeSummary: { characters: merge.source._count.characters, stories: merge.source._count.chatThreads,
              messages: merge.source._count.messages, vc: merge.transferableVC } };
        }
        return { result: "confirmation_required" as const, confirmationToken, siteLabel: siteAccountLabel(target) };
      }
      if (byTelegram) {
        await tx.telegramAccount.update({
          where: { id: byTelegram.id },
          // JWTs identify the link by this id. Rotate it so a relink never revives an old JWT.
          data: { id: randomUUID(), userId: row.userId, origin: "site", linkedAt: now, unlinkedAt: null },
        });
      } else {
        await tx.telegramAccount.create({ data: { telegramId, userId: row.userId, origin: "site", linkedAt: now } });
      }
      return { result: "linked" as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isUniqueViolation(error)) return { result: "telegram_taken" };
    throw error;
  } finally {
    forgetTelegramSessionCache();
    infoLog("Telegram", "link token consumed", { userId: row.userId });
  }
}

/** A populated Telegram-only profile requires its own explicit data-transfer consent. */
export async function confirmTelegramMerge(token: string, telegramId: string): Promise<LinkResult> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token) || !/^[1-9]\d{0,19}$/.test(telegramId)) return "invalid";
  try {
    return await prisma.$transaction(async (tx) => {
      const account = await tx.telegramAccount.findUnique({ where: { telegramId } });
      if (!account?.userId || account.origin !== "telegram") return "invalid";
      const tokenHash = hashLinkToken(`merge:${telegramId}:${account.id}:${token}`);
      const row = await tx.telegramLinkToken.findUnique({ where: { tokenHash } });
      if (!row || row.usedAt || row.expiresAt <= new Date() || row.userId === account.userId) return "invalid";
      if (await tx.telegramAccount.findUnique({ where: { userId: row.userId } })) return "user_has_other_telegram";
      const snapshot = await tx.verificationToken.findUnique({ where: { token: `tg-merge:${tokenHash}` } });
      const preview = await telegramMergePreview(tx, account.userId, row.userId);
      if (preview.status === "busy") return "merge_busy";
      if (preview.status !== "ready") return "profile_not_empty";
      if (!snapshot || snapshot.expires <= new Date() || snapshot.identifier !== preview.fingerprint) return "invalid";
      const claimed = await tx.telegramLinkToken.updateMany({ where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) return "invalid";
      const outcome = await mergeTelegramProfile(tx, account.userId, row.userId);
      if (outcome !== "merged") throw new Error("Telegram merge changed during transaction");
      await tx.telegramAccount.update({ where: { id: account.id }, data: { id: randomUUID(), userId: row.userId, origin: "site", linkedAt: new Date(), unlinkedAt: null } });
      await tx.verificationToken.delete({ where: { token: snapshot.token } });
      return "merged";
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
  } catch (error) {
    if (isUniqueViolation(error) || (error as { code?: string }).code === "P2034") return "invalid";
    throw error;
  } finally { forgetTelegramSessionCache(); }
}

/** Explicit second action from the same Telegram user, tied to the exact previous identity. */
export async function confirmTelegramLink(token: string, telegramId: string): Promise<LinkResult> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token) || !/^[1-9]\d{0,19}$/.test(telegramId)) return "invalid";
  try {
    return await prisma.$transaction(async (tx) => {
      const account = await tx.telegramAccount.findUnique({ where: { telegramId } });
      if (!account?.userId || account.origin !== "telegram") return "invalid";
      const tokenHash = confirmationHash(token, telegramId, account.id);
      const claimed = await tx.telegramLinkToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) return "invalid";
      const row = await tx.telegramLinkToken.findUnique({ where: { tokenHash } });
      if (!row || row.userId === account.userId) return "invalid";
      if (await tx.telegramAccount.findUnique({ where: { userId: row.userId } })) return "user_has_other_telegram";
      // Recheck at confirmation: a chat, bonus, purchase or new login created since the prompt blocks it.
      if (!(await isUnusedTelegramProfile(tx, account))) return "profile_not_empty";
      await tx.telegramAccount.update({ where: { id: account.id }, data: {
        id: randomUUID(), userId: row.userId, origin: "site", linkedAt: new Date(), unlinkedAt: null,
      } });
      return "linked";
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isUniqueViolation(error) || (error as { code?: string }).code === "P2034") return "invalid";
    throw error;
  } finally {
    forgetTelegramSessionCache();
  }
}

export type TelegramLinkStatus = { linked: boolean; linkedAt: string | null; canUnlink: boolean };

export async function getTelegramLinkStatus(userId: string): Promise<TelegramLinkStatus> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { password: true, accounts: { select: { id: true } }, telegramAccount: { select: { linkedAt: true } } },
  });
  const otherLogin = Boolean(user?.password) || Boolean(user?.accounts.length);
  return {
    linked: Boolean(user?.telegramAccount),
    linkedAt: user?.telegramAccount?.linkedAt?.toISOString() ?? null,
    canUnlink: Boolean(user?.telegramAccount) && otherLogin,
  };
}

/**
 * Unlink keeps the account and the Telegram row (userId = null), so Telegram sign-in stays
 * disabled until a new link. Refused when Telegram is the only way to sign in.
 */
export async function unlinkTelegram(userId: string): Promise<"unlinked" | "not_linked" | "only_login_method"> {
  const status = await getTelegramLinkStatus(userId);
  if (!status.linked) return "not_linked";
  if (!status.canUnlink) return "only_login_method";
  const result = await prisma.telegramAccount.updateMany({ where: { userId }, data: { userId: null, unlinkedAt: new Date() } });
  forgetTelegramSessionCache();
  return result.count > 0 ? "unlinked" : "not_linked";
}

// Kept for compatibility with callers/tests from the earlier cached implementation.
// Revocation now reads the database directly, so nothing is cached across requests.
export function forgetTelegramSessionCache(): void {
  // No cache to clear.
}

export async function isTelegramSessionActive(accountId: string, userId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Link check and activity touch share one snapshot: authentication cannot race a transfer.
      return await prisma.$transaction(async (tx) => {
        const account = await tx.telegramAccount.findUnique({ where: { id: accountId }, select: { userId: true } });
        if (account?.userId !== userId) return false;
        await tx.user.updateMany({ where: { id: userId, lastSeen: { lt: new Date(Date.now() - 30_000) } }, data: { lastSeen: new Date() } });
        return true;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2034") throw error;
      // Concurrent activity touches should retry, while a completed merge fails the fresh check.
    }
  }
  return false;
}
