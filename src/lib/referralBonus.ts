import { prisma } from "@/lib/prisma";
import { isEmailVerified } from "@/lib/emailVerification";
import { infoLog } from "@/lib/logger";

export const REFERRAL_BONUS = 100;

export async function grantReferralBonusIfEligible(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      referredBy: true,
      emailVerified: true,
      createdAt: true,
      accounts: { select: { provider: true } },
    },
  });

  if (!user?.referredBy || !isEmailVerified(user)) {
    return;
  }

  const alreadyPaid = await prisma.transaction.findFirst({
    where: {
      userId: user.referredBy,
      type: "referral",
      description: { contains: user.id },
    },
    select: { id: true },
  });

  if (alreadyPaid) {
    return;
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.referredBy },
      data: { realCoins: { increment: REFERRAL_BONUS } },
    }),
    prisma.transaction.create({
      data: {
        userId: user.referredBy,
        amount: REFERRAL_BONUS,
        type: "referral",
        description: `Реферальный бонус за пользователя ${user.id}`,
      },
    }),
  ]);

  infoLog("EmailVerification", "Referral bonus granted", {
    userId: user.id,
    referrerId: user.referredBy,
    amount: REFERRAL_BONUS,
  });
}
