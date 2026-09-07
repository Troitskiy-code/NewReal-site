export type ChatModel = {
  id: string;
  name: string;
  displayName: string;
  pricePer1MInput: number | null;
  pricePer1MOutput: number | null;
  isFreeForSubscribers: boolean;
  isActive: boolean;
};

export type SubscriptionPlan = {
  id: string;
  name: string;
  monthlyPrice: number;
  yearlyPrice: number;
  vcPerMonth: number;
  contextTokens: number;
  contextMultiplier: number;
  priority: boolean;
  ragEnabled: boolean;
  features: string[];
};

/** Paid plans shown on /pricing. Free users stay on type "start" without a public card. */
const FREE_PLAN: SubscriptionPlan = {
  id: "start",
  name: "Старт",
  monthlyPrice: 0,
  yearlyPrice: 0,
  vcPerMonth: 100,
  contextTokens: 6_000,
  contextMultiplier: 1,
  priority: false,
  ragEnabled: false,
  features: [],
};

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    id: "dialog",
    name: "Диалог",
    monthlyPrice: 499,
    yearlyPrice: 4_990,
    vcPerMonth: 2_500,
    contextTokens: 6_000,
    contextMultiplier: 1.5,
    priority: false,
    ragEnabled: true,
    features: [
      "2 500 VC в месяц",
      "Для непринуждённых диалогов и повседневных сцен",
      "Множитель ежедневного бонуса ×1,5",
    ],
  },
  {
    id: "story",
    name: "История",
    monthlyPrice: 1_299,
    yearlyPrice: 12_990,
    vcPerMonth: 10_000,
    contextTokens: 10_000,
    contextMultiplier: 2,
    priority: true,
    ragEnabled: true,
    features: [
      "10 000 VC в месяц",
      "Для длительных ролевых игр и развития сюжета",
      "Множитель ежедневного бонуса ×2",
      "Приоритетная очередь",
    ],
  },
  {
    id: "universe",
    name: "Вселенная",
    monthlyPrice: 3_499,
    yearlyPrice: 37_990,
    vcPerMonth: 30_000,
    contextTokens: 16_000,
    contextMultiplier: 2.5,
    priority: true,
    ragEnabled: true,
    features: [
      "30 000 VC в месяц",
      "Для глубоких миров и сложных сюжетных арок",
      "Множитель ежедневного бонуса ×2,5",
      "Приоритетная очередь",
    ],
  },
];

export const DEFAULT_SUBSCRIPTION_TYPE = "start";

export function getSubscriptionPlan(type: string | null | undefined): SubscriptionPlan {
  const raw = type === "none" || !type ? DEFAULT_SUBSCRIPTION_TYPE : type;
  const normalized = raw === "history" ? "story" : raw;
  if (normalized === DEFAULT_SUBSCRIPTION_TYPE) {
    return FREE_PLAN;
  }
  return SUBSCRIPTION_PLANS.find((plan) => plan.id === normalized) ?? FREE_PLAN;
}

export function getSubscriptionLabel(type: string | null | undefined): string | null {
  const plan = getSubscriptionPlan(type);
  if (plan.id === DEFAULT_SUBSCRIPTION_TYPE) return null;
  return plan.name;
}

export function getContextTokenLimit(
  user: {
    subscriptionType?: string | null;
    subscriptionEnd?: Date | string | null;
  } | null | undefined
): number {
  const type = user?.subscriptionType || "start";
  const subscriptionEnd = user?.subscriptionEnd ? new Date(user.subscriptionEnd) : null;
  const active =
    type !== "none" &&
    type !== "start" &&
    !!subscriptionEnd &&
    subscriptionEnd > new Date();

  if (!active) return getSubscriptionPlan(DEFAULT_SUBSCRIPTION_TYPE).contextTokens;

  return getSubscriptionPlan(type).contextTokens;
}

export function getHistoryMessageLimit(
  type: string | null | undefined,
  subscriptionActive: boolean
): number {
  if (!subscriptionActive) {
    return 25;
  }

  const normalized = type === "history" ? "story" : type;

  switch (normalized) {
    case "universe":
      return 100;
    case "story":
      return 60;
    default:
      return 25;
  }
}

export function getContextMultiplier(
  type: string | null | undefined,
  subscriptionActive: boolean
): number {
  if (!subscriptionActive) {
    return getSubscriptionPlan(DEFAULT_SUBSCRIPTION_TYPE).contextMultiplier;
  }

  return getSubscriptionPlan(type).contextMultiplier;
}

export function getSubscriptionMonthlyVC(type: string | null | undefined): number {
  return getSubscriptionPlan(type).vcPerMonth;
}

export function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function calculateCostRubles(
  inputTokens: number,
  outputTokens: number,
  model: Pick<ChatModel, "pricePer1MInput" | "pricePer1MOutput">
): number {
  const inputPrice = model.pricePer1MInput ?? 0;
  const outputPrice = model.pricePer1MOutput ?? 0;
  return (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
}

export function rublesToRealCoins(rubles: number): number {
  if (rubles <= 0) return 0;
  return Math.max(1, Math.ceil(rubles));
}

export type SubscriptionActivationGrant = {
  subscriptionType: string;
  bonusVC: number;
  contextTokens: number;
  contextMultiplier: number;
  priority: boolean;
  ragEnabled: boolean;
};

export const SUBSCRIPTION_ACTIVATED_TRANSACTION_TYPE = "subscription_activated";

export function getSubscriptionActivationBenefits(plan: SubscriptionPlan, now = new Date()) {
  return {
    user: {
      tokensUsedThisMonth: 0,
      lastTokenMonth: now,
    },
    vcGrant: plan.monthlyPrice > 0 ? plan.vcPerMonth : 0,
    transaction: {
      amount: plan.monthlyPrice > 0 ? plan.vcPerMonth : 0,
      type: SUBSCRIPTION_ACTIVATED_TRANSACTION_TYPE,
      description:
        plan.monthlyPrice > 0
          ? `Зачислено ${plan.vcPerMonth} VC по тарифу «${plan.name}»`
          : `Тариф «${plan.name}»: сгораемые VC обнулены`,
    },
  };
}

export function buildSubscriptionActivationGrant(
  subscriptionType: string
): SubscriptionActivationGrant {
  const plan = getSubscriptionPlan(subscriptionType);

  return {
    subscriptionType: plan.id,
    bonusVC: plan.vcPerMonth,
    contextTokens: plan.contextTokens,
    contextMultiplier: plan.contextMultiplier,
    priority: plan.priority,
    ragEnabled: plan.ragEnabled,
  };
}
