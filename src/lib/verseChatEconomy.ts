export const DAILY_REQUEST_LIMIT = 300;
export const DAILY_LIMIT_WARNING_AT = 270;
export const FREE_TIER_MONTHLY_LIMIT = 10;
export const BASE_MODEL_COST_VC = 2;

export type EconomyUser = {
  id: string;
  verseCoins: number;
  subscriptionType: string | null;
  subscriptionEnd: Date | null;
  freeRequestsUsed: number;
  freeRequestsMonth: Date;
  dailyRequests: number;
  dailyRequestsDate: Date;
};

export type EconomyModel = {
  id: string;
  name: string;
  displayName: string;
  priceVC: number;
  isFreeForSubscribers: boolean;
  isActive: boolean;
};

export type NormalizedCounters = {
  freeRequestsUsed: number;
  freeRequestsMonth: Date;
  dailyRequests: number;
  dailyRequestsDate: Date;
};

export type RequestCostResult =
  | { ok: true; costVC: number; usesFreeTier: boolean }
  | { ok: false; error: string; status: number; details?: Record<string, unknown> };

export function isSubscriptionActive(
  user: Pick<EconomyUser, "subscriptionType" | "subscriptionEnd">
): boolean {
  const type = user.subscriptionType ?? "none";
  if (type === "none") return false;
  if (!user.subscriptionEnd) return false;
  return user.subscriptionEnd > new Date();
}

export function isSameCalendarMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

export function isSameCalendarDay(a: Date, b: Date): boolean {
  const left = new Date(a);
  const right = new Date(b);
  left.setHours(0, 0, 0, 0);
  right.setHours(0, 0, 0, 0);
  return left.getTime() === right.getTime();
}

export function normalizeUserCounters(user: EconomyUser, now = new Date()): NormalizedCounters {
  let freeRequestsUsed = user.freeRequestsUsed;
  let freeRequestsMonth = user.freeRequestsMonth;
  let dailyRequests = user.dailyRequests;
  let dailyRequestsDate = user.dailyRequestsDate;

  if (!isSameCalendarMonth(freeRequestsMonth, now)) {
    freeRequestsUsed = 0;
    freeRequestsMonth = now;
  }

  if (!isSameCalendarDay(dailyRequestsDate, now)) {
    dailyRequests = 0;
    dailyRequestsDate = now;
  }

  return { freeRequestsUsed, freeRequestsMonth, dailyRequests, dailyRequestsDate };
}

export function isBaseModel(model: EconomyModel, baseModel: EconomyModel): boolean {
  return model.id === baseModel.id;
}

export function calculateRequestCost(
  user: EconomyUser,
  model: EconomyModel,
  baseModel: EconomyModel,
  counters: NormalizedCounters
): RequestCostResult {
  const subscribed = isSubscriptionActive(user);
  const base = isBaseModel(model, baseModel);

  if (!subscribed && !base) {
    return {
      ok: false,
      error: "Доступно только по подписке",
      status: 403,
      details: { modelId: model.id, baseModelId: baseModel.id },
    };
  }

  if (subscribed) {
    if (base) {
      return { ok: true, costVC: 0, usesFreeTier: false };
    }
    return { ok: true, costVC: Math.max(0, model.priceVC), usesFreeTier: false };
  }

  if (counters.freeRequestsUsed < FREE_TIER_MONTHLY_LIMIT) {
    return { ok: true, costVC: 0, usesFreeTier: true };
  }

  return { ok: true, costVC: BASE_MODEL_COST_VC, usesFreeTier: false };
}

export function getDailyLimitWarning(dailyRequests: number): string | null {
  if (dailyRequests >= DAILY_LIMIT_WARNING_AT) {
    return `Вы использовали ${dailyRequests} из ${DAILY_REQUEST_LIMIT} суточных запросов.`;
  }
  return null;
}
