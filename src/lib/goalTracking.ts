"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { METRIKA_GOALS, metrikaPlanSlug, reachGoal, subscriptionGoal } from "@/lib/metrika";

function shp(searchParams: URLSearchParams, key: string): string {
  return (searchParams.get(key) || searchParams.get(key.toLowerCase()) || "").trim();
}

function clearPaymentQuery() {
  if (typeof window === "undefined") return;
  window.history.replaceState({}, "", window.location.pathname);
}

export function usePaymentGoal() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const payment = searchParams.get("payment");
    const type = searchParams.get("type") || shp(searchParams, "Shp_type");
    const rawPlan = searchParams.get("plan") || shp(searchParams, "Shp_plan") || "unknown";
    const plan = metrikaPlanSlug(rawPlan);
    const isSubscription =
      type === "subscription" || shp(searchParams, "Shp_subscription").toLowerCase() === "true";
    const isVc = type === "vc" || Boolean(shp(searchParams, "Shp_vc") && !isSubscription);
    const isSuccess = payment === "success" || Boolean(searchParams.get("InvId") && (isSubscription || isVc));

    if (!isSuccess || (!isSubscription && !isVc)) return;

    const timer = window.setTimeout(() => {
      if (isSubscription) {
        const planGoal = subscriptionGoal(plan);
        reachGoal(METRIKA_GOALS.subscriptionSuccess, { plan });
        if (planGoal) reachGoal(planGoal);
        console.log("[Goal] subscription events fired", {
          type: "subscription",
          plan,
          planGoal: planGoal ?? null,
        });
      } else {
        reachGoal(METRIKA_GOALS.vcPurchaseSuccess);
        console.log("[Goal] vc_purchase_success fired", { type: "vc" });
      }
      clearPaymentQuery();
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [searchParams]);
}

export function PaymentGoalTracker() {
  usePaymentGoal();
  return null;
}
