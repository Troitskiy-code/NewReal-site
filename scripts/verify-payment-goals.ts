/**
 * Проверка серверного разбора покупки для целей Метрики.
 * Запуск: node --experimental-strip-types --import ./scripts/alias-register.mjs scripts/verify-payment-goals.ts
 */
import { METRIKA_GOALS, metrikaPlanSlug, subscriptionGoal } from "@/lib/metrika";
import { purchaseGoalsFromStatus } from "@/lib/purchaseGoalRuntime";

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

console.log("Plan slug mapping");
assert(metrikaPlanSlug("story") === "history", "story → history");
assert(subscriptionGoal("story") === METRIKA_GOALS.subscriptionHistory, "story fires subscription_history");
assert(subscriptionGoal("universe") === METRIKA_GOALS.subscriptionUniverse, "universe fires subscription_universe");
assert(subscriptionGoal("start") === null, "start has no plan goal");

console.log("Confirmed purchase specs (query is not the source of truth)");
assert(purchaseGoalsFromStatus({ kind: "purchase", status: "confirmed" })[0]?.goal === METRIKA_GOALS.vcPurchaseSuccess, "VC");
assert(
  purchaseGoalsFromStatus({ kind: "subscription", planId: "dialog", status: "confirmed" }).map((item) => item.goal).join(",") ===
    `${METRIKA_GOALS.subscriptionSuccess},${METRIKA_GOALS.subscriptionDialog}`,
  "dialog two goals"
);
assert(
  purchaseGoalsFromStatus({ kind: "subscription", planId: "story", status: "confirmed" })[1]?.goal ===
    METRIKA_GOALS.subscriptionHistory,
  "story → history"
);
assert(purchaseGoalsFromStatus({ kind: "subscription_renewal", planId: "dialog", status: "confirmed" }).length === 0, "renewal skipped");
assert(purchaseGoalsFromStatus({ kind: "subscription", planId: null, status: "confirmed" }).length === 1, "unknown plan does not invent");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS");
