/**
 * Проверка разбора Success URL / Shp_* для целей Метрики при подписке.
 * Запуск: node --experimental-strip-types scripts/verify-payment-goals.ts
 */
import {
  METRIKA_GOALS,
  metrikaPlanSlug,
  resolvePaymentGoalFromSearchParams,
  subscriptionGoal,
} from "../src/lib/metrika.ts";

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

function params(query: string) {
  return new URLSearchParams(query);
}

console.log("Plan slug mapping");
assert(metrikaPlanSlug("story") === "history", "story → history");
assert(metrikaPlanSlug("dialog") === "dialog", "dialog stays dialog");
assert(subscriptionGoal("story") === METRIKA_GOALS.subscriptionHistory, "story fires subscription_history");
assert(subscriptionGoal("history") === METRIKA_GOALS.subscriptionHistory, "history fires subscription_history");
assert(subscriptionGoal("universe") === METRIKA_GOALS.subscriptionUniverse, "universe fires subscription_universe");
assert(subscriptionGoal("start") === null, "start has no plan goal");

console.log("\nSuccess URL from /api/subscription/create");
{
  const hit = resolvePaymentGoalFromSearchParams(
    params("payment=success&type=subscription&plan=history")
  );
  assert(hit?.kind === "subscription", "detects subscription success");
  assert(hit?.kind === "subscription" && hit.plan === "history", "plan is history");
  assert(
    hit?.kind === "subscription" && hit.planGoal === METRIKA_GOALS.subscriptionHistory,
    "plan goal is subscription_history"
  );
}

console.log("\nRobokassa Shp_* fallback (no payment=success)");
{
  const hit = resolvePaymentGoalFromSearchParams(
    params("InvId=42&Shp_type=subscription&Shp_plan=story&Shp_subscription=true")
  );
  assert(hit?.kind === "subscription", "InvId + Shp_subscription counts as success");
  assert(hit?.kind === "subscription" && hit.plan === "history", "Shp_plan=story maps to history");
}

console.log("\nMixed query: public plan=history and Shp_plan=story");
{
  const hit = resolvePaymentGoalFromSearchParams(
    params("payment=success&type=subscription&plan=history&Shp_plan=story")
  );
  assert(hit?.kind === "subscription" && hit.plan === "history", "prefers public plan=history");
}

console.log("\nDialog and universe");
{
  const dialog = resolvePaymentGoalFromSearchParams(
    params("payment=success&type=subscription&plan=dialog")
  );
  const universe = resolvePaymentGoalFromSearchParams(
    params("payment=success&Shp_subscription=true&Shp_plan=universe&InvId=9")
  );
  assert(
    dialog?.kind === "subscription" && dialog.planGoal === METRIKA_GOALS.subscriptionDialog,
    "dialog → subscription_dialog"
  );
  assert(
    universe?.kind === "subscription" && universe.planGoal === METRIKA_GOALS.subscriptionUniverse,
    "universe → subscription_universe"
  );
}

console.log("\nNon-success and VC");
assert(resolvePaymentGoalFromSearchParams(params("type=subscription&plan=dialog")) === null, "no InvId/payment → skip");
assert(resolvePaymentGoalFromSearchParams(params("payment=success&type=vc"))?.kind === "vc", "VC success");
assert(
  resolvePaymentGoalFromSearchParams(params("InvId=1&Shp_vc=100&Shp_type=vc"))?.kind === "vc",
  "VC via Shp_vc"
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS");
