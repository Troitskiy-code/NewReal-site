/**
 * Проверка сценариев экономики без БД.
 * Запуск: node --experimental-strip-types scripts/verify-economy.ts
 */
import {
  calculateRequestCost,
  isSubscriptionActive,
  normalizeUserCounters,
  type EconomyModel,
  type EconomyUser,
} from "../src/lib/verseChatEconomy.ts";
import {
  DAILY_BONUS_AMOUNTS,
  applyBonusMultiplier,
  getBonusForStreak,
  getBonusMultiplier,
  getNextStreak,
} from "../src/lib/dailyBonus.ts";
import {
  SUBSCRIPTION_ACTIVATED_TRANSACTION_TYPE,
  getSubscriptionActivationBenefits,
  getSubscriptionPlan,
  SUBSCRIPTION_PLANS,
} from "../src/lib/chatEconomy.ts";
import {
  FREE_DAILY_REPLIES,
  FREE_DAILY_REPLIES_ONBOARDING,
  freeDailyLimit,
  getFreeQuotaState,
  isSameMoscowDay,
  moscowDayKey,
  nextMoscowMidnight,
} from "../src/lib/freeDailyQuota.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const baseModel: EconomyModel = {
  id: "base",
  name: "google/gemma-4-31b",
  displayName: "Base",
  priceVC: 4,
  maxContextTokens: 4000,
  isFreeForSubscribers: false,
  isActive: true,
};

const paidModel: EconomyModel = {
  id: "paid",
  name: "gpt-pro",
  displayName: "Pro",
  priceVC: 15,
  maxContextTokens: 8000,
  isFreeForSubscribers: false,
  isActive: true,
};

const now = new Date("2026-08-11T12:00:00");

function makeUser(overrides: Partial<EconomyUser> = {}): EconomyUser {
  return {
    id: "u1",
    verseCoins: 100,
    subscriptionType: "none",
    subscriptionEnd: null,
    dailyRequests: 0,
    dailyRequestsDate: now,
    ...overrides,
  };
}

console.log("\n1. Пользователь без подписки");
{
  const user = makeUser();
  const baseCost = calculateRequestCost(user, baseModel, baseModel);
  assert(baseCost.ok === true && baseCost.costVC === 4, "базовая модель: 4 VC");

  const paidCost = calculateRequestCost(user, paidModel, baseModel);
  assert(paidCost.ok === true && paidCost.costVC === 15, "платная модель доступна по priceVC");
}

console.log("\n2. Подписка «Диалог»");
{
  const user = makeUser({
    subscriptionType: "dialog",
    subscriptionEnd: new Date("2026-09-01"),
  });

  const basePaid = calculateRequestCost(user, baseModel, baseModel);
  assert(basePaid.ok === true && basePaid.costVC === 4, "базовая модель платная и с подпиской");

  const paidCost = calculateRequestCost(user, paidModel, baseModel);
  assert(paidCost.ok === true && paidCost.costVC === 15, "платная модель по priceVC");
}

console.log("\n3. Ежедневный бонус (серия 1–7, сброс)");
{
  for (let streak = 1; streak <= 7; streak += 1) {
    assert(getBonusForStreak(streak) === DAILY_BONUS_AMOUNTS[streak - 1], `день ${streak}: ${DAILY_BONUS_AMOUNTS[streak - 1]} VC`);
  }
  assert(getNextStreak(7) === 1, "после 7-го дня серия сбрасывается на 1");
  assert(getBonusForStreak(getNextStreak(7)) === 10, "новый цикл начинается с 10 VC");
}

console.log("\n4b. Множитель ежедневного бонуса");
{
  assert(getBonusMultiplier(null) === 1, "null → x1");
  assert(getBonusMultiplier("free") === 1, "free → x1");
  assert(getBonusMultiplier("dialog") === 1.5, "dialog → x1.5");
  assert(getBonusMultiplier("history") === 2, "history → x2");
  assert(getBonusMultiplier("story") === 2, "story → x2");
  assert(getBonusMultiplier("universe") === 2.5, "universe → x2.5");
  assert(getBonusMultiplier("unknown-plan") === 1, "неизвестный тип → x1");
  assert(applyBonusMultiplier(10, null) === 10, "день 1 без подписки: 10");
  assert(applyBonusMultiplier(10, "dialog") === 15, "день 1 Диалог: 15");
  assert(applyBonusMultiplier(15, "dialog") === 23, "день 2 Диалог: 23");
  assert(applyBonusMultiplier(10, "history") === 20, "день 1 История: 20");
  assert(applyBonusMultiplier(10, "universe") === 25, "день 1 Вселенная: 25");
}

console.log("\n4. Суточный счётчик не ограничивает отправку");
{
  const user = makeUser({ dailyRequests: 500 });
  const sameDay = normalizeUserCounters(user, now);
  assert(sameDay.dailyRequests === 500, "счётчик не блокирует запросы");

  const nextDay = normalizeUserCounters(user, new Date("2026-08-12T01:00:00"));
  assert(nextDay.dailyRequests === 0, "на новый календарный день счётчик сбрасывается");
}

console.log("\n5. Активность подписки");
{
  assert(
    isSubscriptionActive({ subscriptionType: "dialog", subscriptionEnd: new Date(Date.now() + 86_400_000) }),
    "активная подписка"
  );
  assert(
    !isSubscriptionActive({ subscriptionType: "dialog", subscriptionEnd: new Date(Date.now() - 86_400_000) }),
    "истёкшая подписка"
  );
  assert(!isSubscriptionActive({ subscriptionType: "none", subscriptionEnd: null }), "без подписки");
}

console.log("\n6. Активация подписки заменяет сгораемые VC и сбрасывает генерации");
{
  const now = new Date("2026-08-30T12:00:00");
  const dialog = getSubscriptionActivationBenefits(getSubscriptionPlan("dialog"), now);
  assert(dialog.vcGrant === 2_500, "Диалог: сгораемые VC = 2500, не сумма");
  assert(!("verseCoins" in dialog.user), "постоянные VC не перезаписываются");
  assert(dialog.user.tokensUsedThisMonth === 0, "Диалог: генерации сброшены");
  assert(dialog.user.lastTokenMonth.getTime() === now.getTime(), "Диалог: месяц генераций начинается сейчас");
  assert(dialog.transaction.type === SUBSCRIPTION_ACTIVATED_TRANSACTION_TYPE, "тип транзакции subscription_activated");
  assert(dialog.transaction.amount === 2_500, "сумма транзакции = VC тарифа");

  const cheaper = getSubscriptionActivationBenefits(getSubscriptionPlan("dialog"), now);
  const expensive = getSubscriptionActivationBenefits(getSubscriptionPlan("universe"), now);
  assert(cheaper.vcGrant === 2_500, "переход на Диалог: 2500 сгораемых VC");
  assert(expensive.vcGrant === 30_000, "Вселенная: 30000 сгораемых VC");
  assert(cheaper.vcGrant < expensive.vcGrant, "более дешёвый тариф даёт меньше VC (замена, не сумма)");
}

console.log("\n7. RAG для платных подписок");
{
  assert(SUBSCRIPTION_PLANS.length === 3, "публичные тарифы: Диалог, История, Вселенная");
  assert(!SUBSCRIPTION_PLANS.some((plan) => plan.id === "start"), "Старт не в списке тарифов");
  assert(!getSubscriptionPlan("start").ragEnabled, "без подписки: RAG выключен");
  assert(getSubscriptionPlan("dialog").ragEnabled, "Диалог: RAG включён");
  assert(getSubscriptionPlan("story").ragEnabled, "История: RAG включён");
  assert(getSubscriptionPlan("history").ragEnabled, "history: RAG включён");
  assert(getSubscriptionPlan("universe").ragEnabled, "Вселенная: RAG включён");
}

console.log("\n8. Бесплатная дневная квота на базовой модели");
{
  // 2026-10-17 12:00 MSK = 09:00 UTC; Moscow midnight is 21:00 UTC.
  const at = (iso: string) => new Date(iso);
  const signup = at("2026-10-17T09:00:00Z");
  const quotaUser = (overrides: Partial<EconomyUser> = {}) =>
    makeUser({ verseCoins: 0, createdAt: signup, dailyRequests: 0, dailyRequestsDate: signup, ...overrides });
  const on = (now: Date) => ({ freeQuotaEnabled: true, now });

  const off = calculateRequestCost(quotaUser(), baseModel, baseModel, { now: signup });
  assert(off.ok && off.costVC === 4 && off.freeQuota === null && !off.freeQuotaEligible, "флаг выключен: базовая модель по priceVC");

  const first = calculateRequestCost(quotaUser(), baseModel, baseModel, on(signup));
  assert(first.ok && first.costVC === 0 && first.priceVC === 4 && first.freeQuota?.limit === 20, "день регистрации: 20 бесплатных, ответ за 0 VC");

  const paid = calculateRequestCost(quotaUser(), paidModel, baseModel, on(signup));
  assert(paid.ok && paid.costVC === 15 && !paid.freeQuotaEligible && paid.freeQuota?.remaining === 20, "другая модель: платно, квота не тратится");

  const noCreatedAt = calculateRequestCost(makeUser(), baseModel, baseModel, on(signup));
  assert(noCreatedAt.ok && noCreatedAt.costVC === 4 && noCreatedAt.freeQuota === null, "без createdAt квота не применяется");

  const used19 = calculateRequestCost(quotaUser({ dailyRequests: 19 }), baseModel, baseModel, on(signup));
  assert(used19.ok && used19.costVC === 0 && used19.freeQuota?.remaining === 1, "19 из 20: последний бесплатный");
  const used20 = calculateRequestCost(quotaUser({ dailyRequests: 20 }), baseModel, baseModel, on(signup));
  assert(used20.ok && used20.costVC === 4 && used20.freeQuota?.remaining === 0, "20 из 20: дальше по priceVC");

  const beforeMidnight = at("2026-10-17T20:59:59Z");
  const afterMidnight = at("2026-10-17T21:00:00Z");
  assert(isSameMoscowDay(signup, beforeMidnight), "23:59:59 МСК — тот же день");
  assert(!isSameMoscowDay(signup, afterMidnight), "00:00 МСК — новый день");
  assert(moscowDayKey(afterMidnight) === "2026-10-18", "ключ дня по Москве, не по UTC");
  const reset = calculateRequestCost(quotaUser({ dailyRequests: 20 }), baseModel, baseModel, on(afterMidnight));
  assert(reset.ok && reset.costVC === 0 && reset.freeQuota?.used === 0, "после полуночи МСК счётчик обнулился");
  assert(nextMoscowMidnight(signup).toISOString() === "2026-10-17T21:00:00.000Z", "сброс в 00:00 МСК");

  assert(freeDailyLimit(signup, at("2026-10-23T20:59:59Z")) === FREE_DAILY_REPLIES_ONBOARDING, "7-й день (23.10 МСК): ещё 20");
  assert(freeDailyLimit(signup, at("2026-10-23T21:00:00Z")) === FREE_DAILY_REPLIES, "8-й день (24.10 МСК): 5");
  const lateSignup = at("2026-10-17T20:30:00Z"); // 23:30 MSK
  assert(freeDailyLimit(lateSignup, at("2026-10-23T20:00:00Z")) === 20 && freeDailyLimit(lateSignup, at("2026-10-23T21:00:00Z")) === 5, "регистрация в 23:30 МСК — неделя считается по календарю");

  const week2 = calculateRequestCost(quotaUser({ dailyRequests: 5, dailyRequestsDate: at("2026-10-25T09:00:00Z") }), baseModel, baseModel, on(at("2026-10-25T10:00:00Z")));
  assert(week2.ok && week2.costVC === 4 && week2.freeQuota?.limit === 5, "вторая неделя: 5 из 5 использованы — платно");

  const subscriber = calculateRequestCost(quotaUser({ subscriptionType: "dialog", subscriptionEnd: at("2026-11-17T00:00:00Z") }), baseModel, baseModel, on(signup));
  assert(subscriber.ok && subscriber.costVC === 0, "подписчик тоже получает квоту");

  const state = getFreeQuotaState({ createdAt: signup, dailyRequests: -3, dailyRequestsDate: signup }, signup);
  assert(state.used === 0 && state.remaining === 20, "отрицательный счётчик не даёт лишних ответов");
}

console.log("\n9. Бесплатные ответы в тарифах");
{
  const signup = new Date("2026-10-01T09:00:00Z");
  const now = new Date("2026-10-17T09:00:00Z"); // third week: no onboarding bonus
  const active = new Date("2026-11-17T00:00:00Z");
  const expired = new Date("2026-10-16T00:00:00Z");
  assert(getSubscriptionPlan("dialog").freeDailyReplies === 30, "Диалог: 30 в день");
  assert(getSubscriptionPlan("story").freeDailyReplies === 60 && getSubscriptionPlan("history").freeDailyReplies === 60, "История (и history): 60 в день");
  assert(getSubscriptionPlan("universe").freeDailyReplies === 100, "Вселенная: 100 в день");
  assert(getSubscriptionPlan("start").freeDailyReplies === 0, "без подписки план не добавляет ответов");
  assert(freeDailyLimit(signup, now, { subscriptionType: "dialog", subscriptionEnd: active }) === 30, "активный Диалог: лимит 30");
  assert(freeDailyLimit(signup, now, { subscriptionType: "universe", subscriptionEnd: active }) === 100, "активная Вселенная: лимит 100");
  assert(freeDailyLimit(signup, now, { subscriptionType: "dialog", subscriptionEnd: expired }) === FREE_DAILY_REPLIES, "истёкшая подписка: обычные 5");
  assert(freeDailyLimit(signup, now, { subscriptionType: "dialog", subscriptionEnd: null }) === FREE_DAILY_REPLIES, "подписка без даты окончания не считается активной");
  assert(freeDailyLimit(now, now, { subscriptionType: "dialog", subscriptionEnd: active }) === 30, "новичок с Диалогом: max(20, 30) = 30");
  const user = makeUser({ verseCoins: 0, createdAt: signup, dailyRequests: 29, dailyRequestsDate: now, subscriptionType: "story", subscriptionEnd: active });
  const story = calculateRequestCost(user, baseModel, baseModel, { freeQuotaEnabled: true, now });
  assert(story.ok && story.costVC === 0 && story.freeQuota?.limit === 60 && story.freeQuota.remaining === 31, "История: 29 из 60 — ответ бесплатный, осталось 31");
}

console.log(`\nИтого: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
