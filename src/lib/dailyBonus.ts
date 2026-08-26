export const DAILY_BONUS_AMOUNTS = [10, 15, 20, 25, 30, 35, 40];

export function startOfDay(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

export function isSameCalendarDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

export function getMsUntilNextDay(now = new Date()): number {
  const nextDay = startOfDay(now);
  nextDay.setDate(nextDay.getDate() + 1);
  return Math.max(0, nextDay.getTime() - now.getTime());
}

export function getBonusForStreak(streak: number): number {
  const index = Math.min(Math.max(streak, 1), 7) - 1;
  return DAILY_BONUS_AMOUNTS[index];
}

export function getBonusMultiplier(subscriptionType: string | null): number {
  const type = (subscriptionType ?? "").trim().toLowerCase();

  if (!type || type === "free" || type === "none" || type === "start") {
    return 1;
  }
  if (type === "dialog") {
    return 1.5;
  }
  if (type === "history" || type === "story") {
    return 2;
  }
  if (type === "universe") {
    return 2.5;
  }

  return 1;
}

export function applyBonusMultiplier(baseBonus: number, subscriptionType: string | null): number {
  return Math.round(baseBonus * getBonusMultiplier(subscriptionType));
}

export function getNextStreak(currentStreak: number): number {
  const nextStreak = currentStreak + 1;
  return nextStreak > 7 ? 1 : nextStreak;
}

export function getNextBonus(currentStreak: number): number {
  return getBonusForStreak(getNextStreak(currentStreak));
}

export function getUpcomingBonusStreak(currentStreak: number): number {
  return getNextStreak(currentStreak);
}

export { getSubscriptionLabel } from "@/lib/chatEconomy";
