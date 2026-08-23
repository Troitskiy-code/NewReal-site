export const DAILY_REQUEST_LIMIT = 300;
export const DAILY_LIMIT_WARNING_AT = 270;
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
  | { ok: true; costVC: number }
  | { ok: false; error: string; status: number; details?: Record<string, unknown> };

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

export function calculateRequestCost(
  user: EconomyUser,
  model: EconomyModel,
  baseModel: EconomyModel
): RequestCostResult {
  return {
    ok: true,
    costVC: getEffectiveModelPriceVC(user, model, baseModel),
  };
}

export function getDailyLimitWarning(dailyRequests: number): string | null {
  if (dailyRequests >= DAILY_LIMIT_WARNING_AT) {
    return `Вы использовали ${dailyRequests} из ${DAILY_REQUEST_LIMIT} суточных запросов.`;
  }
  return null;
}
