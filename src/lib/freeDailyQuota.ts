/**
 * Free daily replies on the base model. Shared by the chat route, the balance API and the
 * chat client, so the preview and the actual debit agree. The switch itself is server-only
 * (FREE_DAILY_QUOTA_ENABLED); the client learns it from `freeQuota` in /api/user/balance.
 */
export const FREE_DAILY_REPLIES_ONBOARDING = 20;
export const FREE_ONBOARDING_DAYS = 7;
export const FREE_DAILY_REPLIES = 5;
export const FREE_CHAT_TRANSACTION_TYPE = "chat_free";

// Russia has no daylight saving time, so Moscow is always UTC+3.
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type FreeQuotaCounters = {
  createdAt: Date | string;
  dailyRequests: number;
  dailyRequestsDate: Date | string;
};

export type FreeQuotaState = {
  limit: number;
  used: number;
  remaining: number;
  /** ISO time of the next Moscow midnight. */
  resetsAt: string;
};

function moscowDayNumber(date: Date | string | number): number {
  return Math.floor((new Date(date).getTime() + MOSCOW_OFFSET_MS) / DAY_MS);
}

/** Calendar day in Moscow as YYYY-MM-DD. */
export function moscowDayKey(date: Date | string | number): string {
  return new Date(moscowDayNumber(date) * DAY_MS).toISOString().slice(0, 10);
}

export function isSameMoscowDay(a: Date | string | number, b: Date | string | number): boolean {
  return moscowDayNumber(a) === moscowDayNumber(b);
}

export function nextMoscowMidnight(now = new Date()): Date {
  return new Date((moscowDayNumber(now) + 1) * DAY_MS - MOSCOW_OFFSET_MS);
}

/** 20 on the registration day and the six days after it (Moscow calendar), 5 afterwards. */
export function freeDailyLimit(createdAt: Date | string, now = new Date()): number {
  const daysSinceSignup = moscowDayNumber(now) - moscowDayNumber(createdAt);
  return daysSinceSignup < FREE_ONBOARDING_DAYS ? FREE_DAILY_REPLIES_ONBOARDING : FREE_DAILY_REPLIES;
}

/** Replies already used today; the stored counter belongs to an earlier day once midnight passes. */
export function freeRepliesUsedToday(counters: Pick<FreeQuotaCounters, "dailyRequests" | "dailyRequestsDate">, now = new Date()): number {
  return isSameMoscowDay(counters.dailyRequestsDate, now) ? Math.max(0, counters.dailyRequests) : 0;
}

export function getFreeQuotaState(counters: FreeQuotaCounters, now = new Date()): FreeQuotaState {
  const limit = freeDailyLimit(counters.createdAt, now);
  const used = freeRepliesUsedToday(counters, now);
  return { limit, used, remaining: Math.max(0, limit - used), resetsAt: nextMoscowMidnight(now).toISOString() };
}
