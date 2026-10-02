import { getSubscriptionPlan } from "./chatEconomy";

// Budget assumption, not a claim about the provider's settled invoice.
export const AVATAR_BASE_COST_RUB = 5;
export const AVATAR_SUBSCRIPTION_BUDGET_SHARE = 0.1;

export function avatarMonthlyAllowance(type: string | null | undefined): number {
  const plan = getSubscriptionPlan(type);
  // Calculate in kopecks to avoid floating-point boundary errors.
  return Math.floor(Math.round(plan.monthlyPrice * 100) / 10 / (AVATAR_BASE_COST_RUB * 100));
}
