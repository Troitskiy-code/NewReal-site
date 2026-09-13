"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { METRIKA_GOALS, reachGoal } from "@/lib/metrika";

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
    const plan = searchParams.get("plan") || shp(searchParams, "Shp_plan") || "unknown";
    const isSubscription =
      type === "subscription" || shp(searchParams, "Shp_subscription").toLowerCase() === "true";
    const isVc = type === "vc" || Boolean(shp(searchParams, "Shp_vc") && !isSubscription);
    const isSuccess = payment === "success" || Boolean(searchParams.get("InvId") && (isSubscription || isVc));

    if (!isSuccess || (!isSubscription && !isVc)) return;

    const timer = window.setTimeout(() => {
      if (isSubscription) {
        reachGoal(METRIKA_GOALS.subscriptionSuccess, { plan });
        console.log("[Goal] subscription_success fired", { plan });
      } else {
        reachGoal(METRIKA_GOALS.vcPurchaseSuccess);
        console.log("[Goal] vc_purchase_success fired");
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
