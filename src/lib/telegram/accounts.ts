import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { applySignupBenefits } from "@/lib/provisionNewUser";
import { grantReferralBonusIfEligible } from "@/lib/referralBonus";
import { normalizeTelegramReferralCode } from "./shared";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import type { TelegramLaunchUser } from "./initData";

export const LINK_TOKEN_TTL_MS = 10 * 60 * 1000;
export const LINK_START_PREFIX = "link_";

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
    prisma.telegramLinkToken.create({ data: { tokenHash: hashLinkToken(token), userId, expiresAt } }),
  ]);
  return { token, expiresAt };
}

export type LinkResult = "linked" | "already_linked" | "invalid" | "telegram_taken" | "user_has_other_telegram";

/**
 * Consumes link_<token> from the bot. The token is single-use (an atomic update marks it used
 * before anything else), bound to the user that created it and short-lived. A Telegram account
 * that already belongs to another user is never moved: accounts are not merged.
 */
export async function consumeLinkToken(token: string, telegramId: string): Promise<LinkResult> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token) || !/^[1-9]\d{0,19}$/.test(telegramId)) return "invalid";
  const tokenHash = hashLinkToken(token);
  const now = new Date();
  const claimed = await prisma.telegramLinkToken.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) return "invalid";
  const row = await prisma.telegramLinkToken.findUnique({ where: { tokenHash }, select: { userId: true } });
  if (!row) return "invalid";
  try {
    return await prisma.$transaction(async (tx) => {
      const [byTelegram, byUser] = await Promise.all([
        tx.telegramAccount.findUnique({ where: { telegramId }, select: { id: true, userId: true } }),
        tx.telegramAccount.findUnique({ where: { userId: row.userId }, select: { id: true, telegramId: true } }),
      ]);
      if (byTelegram?.userId === row.userId) return "already_linked" as const;
      if (byTelegram?.userId) return "telegram_taken" as const;
      if (byUser && byUser.telegramId !== telegramId) return "user_has_other_telegram" as const;
      if (byTelegram) {
        await tx.telegramAccount.update({
          where: { id: byTelegram.id },
          // JWTs identify the link by this id. Rotate it so a relink never revives an old JWT.
          data: { id: randomUUID(), userId: row.userId, origin: "site", linkedAt: now, unlinkedAt: null },
        });
      } else {
        await tx.telegramAccount.create({ data: { telegramId, userId: row.userId, origin: "site", linkedAt: now } });
      }
      return "linked" as const;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return "telegram_taken";
    throw error;
  } finally {
    forgetTelegramSessionCache();
    infoLog("Telegram", "link token consumed", { userId: row.userId });
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

// Sessions issued by a Telegram launch carry the account id. A short cache keeps the per-request
// check cheap; an unlink takes effect on this instance at once and elsewhere within the TTL.
const SESSION_CACHE_TTL_MS = 60 * 1000;
const sessionCache = new Map<string, { userId: string | null; at: number }>();

export function forgetTelegramSessionCache(): void {
  sessionCache.clear();
}

export async function isTelegramSessionActive(accountId: string, userId: string): Promise<boolean> {
  const cached = sessionCache.get(accountId);
  if (cached && Date.now() - cached.at < SESSION_CACHE_TTL_MS) return cached.userId === userId;
  const account = await prisma.telegramAccount.findUnique({ where: { id: accountId }, select: { userId: true } });
  if (sessionCache.size > 5000) sessionCache.clear();
  sessionCache.set(accountId, { userId: account?.userId ?? null, at: Date.now() });
  return account?.userId === userId;
}
