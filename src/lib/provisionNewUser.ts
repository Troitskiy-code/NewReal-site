import { prisma } from "@/lib/prisma";
import { DEFAULT_SUBSCRIPTION_TYPE, getSubscriptionPlan } from "@/lib/chatEconomy";
import { grantPermanentUpdate } from "@/lib/verseCoins";

export const SIGNUP_VC_GRANT = getSubscriptionPlan(DEFAULT_SUBSCRIPTION_TYPE).vcPerMonth;
export const SIGNUP_BONUS_TRANSACTION_TYPE = "signup_bonus";

export async function applySignupBenefits(userId: string): Promise<void> {
  const plan = getSubscriptionPlan(DEFAULT_SUBSCRIPTION_TYPE);
  await prisma.user.update({
    where: { id: userId },
    data: {
      subscriptionType: DEFAULT_SUBSCRIPTION_TYPE,
      ...grantPermanentUpdate(SIGNUP_VC_GRANT),
    },
  });
  await prisma.transaction.create({
    data: {
      userId,
      amount: SIGNUP_VC_GRANT,
      type: SIGNUP_BONUS_TRANSACTION_TYPE,
      description: `Стартовый пакет: тариф «${plan.name}», ${SIGNUP_VC_GRANT} VC`,
    },
  });
  console.log(`[Signup] Granted start plan and ${SIGNUP_VC_GRANT} VC user=${userId}`);
}
