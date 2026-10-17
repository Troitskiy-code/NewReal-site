import { getFreeQuotaState, type FreeQuotaState } from "./freeDailyQuota";

export const BASE_MODEL_COST_VC = 2;

export {
  buildSubscriptionActivationGrant,
  getContextMultiplier,
  getContextTokenLimit,
  getHistoryMessageLimit,
  getSubscriptionMonthlyVC,
  getSubscriptionPlan,
} from "./chatEconomy";

export type EconomyUser = {
  id: string;
  verseCoins: number;
  subscriptionType: string | null;
  subscriptionEnd: Date | null;
  dailyRequests: number;
  dailyRequestsDate: Date;
  /** Needed for the free daily quota; without it the quota never applies. */
  createdAt?: Date;
};

export type EconomyModel = {
  id: string;
  name: string;
  displayName: string;
  priceVC: number;
  maxContextTokens: number;
  isFreeForSubscribers: boolean;
  isActive: boolean;
};

export type NormalizedCounters = {
  dailyRequests: number;
  dailyRequestsDate: Date;
};

export type RequestCostResult =
  | {
      ok: true;
      /** What this request costs the user now: 0 while the free daily quota covers it. */
      costVC: number;
      /** The model price, charged once the free quota is used up. */
      priceVC: number;
      /** Whether the free quota applies to this model at all (base model, quota switched on). */
      freeQuotaEligible: boolean;
      freeQuota: FreeQuotaState | null;
    }
  | { ok: false; error: string; status: number; details?: Record<string, unknown> };

export type RequestCostOptions = { freeQuotaEnabled?: boolean; now?: Date };

export function isSubscriptionActive(
  user: Pick<EconomyUser, "subscriptionType" | "subscriptionEnd">
): boolean {
  const type = user.subscriptionType ?? "none";
  if (type === "none" || type === "start") return false;
  if (!user.subscriptionEnd) return false;
  return user.subscriptionEnd > new Date();
}

export function isSameCalendarDay(a: Date, b: Date): boolean {
  const left = new Date(a);
  const right = new Date(b);
  left.setHours(0, 0, 0, 0);
  right.setHours(0, 0, 0, 0);
  return left.getTime() === right.getTime();
}

export function normalizeUserCounters(user: EconomyUser, now = new Date()): NormalizedCounters {
  let dailyRequests = user.dailyRequests;
  let dailyRequestsDate = user.dailyRequestsDate;

  if (!isSameCalendarDay(dailyRequestsDate, now)) {
    dailyRequests = 0;
    dailyRequestsDate = now;
  }

  return { dailyRequests, dailyRequestsDate };
}

export function isBaseModel(model: EconomyModel, baseModel: EconomyModel): boolean {
  return model.id === baseModel.id;
}

export function getEffectiveModelPriceVC(
  _user: Pick<EconomyUser, "subscriptionType" | "subscriptionEnd">,
  model: EconomyModel,
  _baseModel: EconomyModel
): number {
  return Math.max(0, model.priceVC);
}

/**
 * A preview: the authoritative free-or-paid decision is made under the row lock in
 * reserveChatCharge, so parallel requests cannot share the last free reply.
 */
export function calculateRequestCost(
  user: EconomyUser,
  model: EconomyModel,
  baseModel: EconomyModel,
  options: RequestCostOptions = {}
): RequestCostResult {
  const priceVC = getEffectiveModelPriceVC(user, model, baseModel);
  const freeQuota =
    options.freeQuotaEnabled && user.createdAt
      ? getFreeQuotaState({ createdAt: user.createdAt, dailyRequests: user.dailyRequests, dailyRequestsDate: user.dailyRequestsDate, subscriptionType: user.subscriptionType, subscriptionEnd: user.subscriptionEnd }, options.now)
      : null;
  const freeQuotaEligible = Boolean(freeQuota && priceVC > 0 && isBaseModel(model, baseModel));
  return {
    ok: true,
    costVC: freeQuotaEligible && freeQuota!.remaining > 0 ? 0 : priceVC,
    priceVC,
    freeQuotaEligible,
    freeQuota,
  };
}

