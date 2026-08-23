/**
 * Проверка сценариев экономики без БД.
 * Запуск: node --experimental-strip-types scripts/verify-economy.ts
 */
import {
  calculateRequestCost,
  DAILY_REQUEST_LIMIT,
  getDailyLimitWarning,
  isSubscriptionActive,
  normalizeUserCounters,
  type EconomyModel,
  type EconomyUser,
} from "../src/lib/verseChatEconomy.ts";
import {
  DAILY_BONUS_AMOUNTS,
  getBonusForStreak,
  getNextStreak,
} from "../src/lib/dailyBonus.ts";

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

console.log("\n4. Суточный лимит 300");
{
  const user = makeUser({ dailyRequests: 299 });
  const counters = normalizeUserCounters(user, now);
  assert(counters.dailyRequests === 299, "299 запросов — ещё можно");
  assert(counters.dailyRequests < DAILY_REQUEST_LIMIT, "300-й запрос допустим");

  const blocked = normalizeUserCounters(makeUser({ dailyRequests: 300 }), now);
  assert(blocked.dailyRequests >= DAILY_REQUEST_LIMIT, "300+ — блокировка");
  assert(getDailyLimitWarning(270) !== null, "предупреждение с 270");
}

console.log("\n5. Активность подписки");
{
  assert(
    isSubscriptionActive({ subscriptionType: "dialog", subscriptionEnd: new Date("2026-09-01") }),
    "активная подписка"
  );
  assert(
    !isSubscriptionActive({ subscriptionType: "dialog", subscriptionEnd: new Date("2026-01-01") }),
    "истёкшая подписка"
  );
  assert(!isSubscriptionActive({ subscriptionType: "none", subscriptionEnd: null }), "без подписки");
}

console.log(`\nИтого: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
