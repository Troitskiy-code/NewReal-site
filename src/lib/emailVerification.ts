import crypto from "crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiT } from "@/lib/apiI18n";
import { sendVerificationEmail } from "@/lib/email";
import { ensureEmailVerificationTable } from "@/lib/ensureEmailVerification";
import { errorLog, infoLog } from "@/lib/logger";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18nConfig";

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

type EmailVerificationUser = {
  emailVerified?: Date | string | null;
  createdAt?: Date | string | null;
  accounts?: { provider: string }[];
};

function getVerificationCutoffDate(): Date | null {
  const raw = process.env.EMAIL_VERIFICATION_CUTOFF_DATE?.trim();
  if (!raw) return null;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    console.error("[EmailVerification] Invalid EMAIL_VERIFICATION_CUTOFF_DATE", raw);
    return null;
  }

  return parsed;
}

export function isEmailVerified(user: EmailVerificationUser | null | undefined): boolean {
  if (!user) return false;
  if (user.emailVerified) return true;
  if (user.accounts?.some((account) => account.provider === "google")) return true;

  // Temporary grandfathering until POST /api/admin/verify-all-users is applied.
  // Remove this cutoff after the backfill; then only emailVerified and Google count.
  const cutoff = getVerificationCutoffDate();
  if (cutoff && user.createdAt) {
    const createdAt =
      user.createdAt instanceof Date ? user.createdAt : new Date(user.createdAt);
    if (!Number.isNaN(createdAt.getTime()) && createdAt < cutoff) {
      return true;
    }
  }

  return false;
}

export async function createAndSendVerificationEmail(
  userId: string,
  email: string,
  locale: Locale = DEFAULT_LOCALE,
  logPrefix = "EmailVerification"
): Promise<void> {
  await ensureEmailVerificationTable();

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  await prisma.$transaction([
    prisma.emailVerificationToken.deleteMany({ where: { userId } }),
    prisma.emailVerificationToken.create({
      data: { token, userId, expiresAt },
    }),
  ]);

  infoLog(logPrefix, "Token created", { userId, expiresAt: expiresAt.toISOString() });

  try {
    await sendVerificationEmail(email, token, locale);
    infoLog(logPrefix, "Email sent", { userId, to: email });
  } catch (error) {
    errorLog(logPrefix, "Failed to send email", { userId, to: email, error });
    throw error;
  }
}

export async function rejectUnverifiedEmail(
  req: NextRequest,
  userId: string,
  messageKey: string
): Promise<NextResponse | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      emailVerified: true,
      createdAt: true,
      accounts: { select: { provider: true } },
    },
  });

  if (!user) {
    return NextResponse.json({ error: apiT(req, "api.userNotFound") }, { status: 404 });
  }

  if (isEmailVerified(user)) {
    return null;
  }

  return NextResponse.json({ error: apiT(req, messageKey) }, { status: 403 });
}
