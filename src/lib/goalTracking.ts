"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import {
  METRIKA_GOALS,
  reachGoal,
  resolvePaymentGoalFromSearchParams,
  waitForMetrika,
  type PaymentGoalHit,
} from "@/lib/metrika";

function clearPaymentQuery() {
  if (typeof window === "undefined") return;
  window.history.replaceState({}, "", window.location.pathname);
}

function goalStorageKey(hit: PaymentGoalHit, invId: string): string {
  if (hit.kind === "subscription") {
    return `nv-metrika-goal:subscription:${hit.plan}:${invId || "ok"}`;
  }
  return `nv-metrika-goal:vc:${invId || "ok"}`;
}

function alreadyFired(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function markFired(key: string) {
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    /* ignore quota / private mode */
  }
}

function firePaymentGoal(hit: PaymentGoalHit): boolean {
  if (hit.kind === "subscription") {
    const success = reachGoal(METRIKA_GOALS.subscriptionSuccess, { plan: hit.plan });
    const planOk = hit.planGoal ? reachGoal(hit.planGoal) : true;
    console.log("[Goal] subscription events fired", {
      type: "subscription",
      plan: hit.plan,
      planGoal: hit.planGoal,
      sent: success && planOk,
    });
    return success && planOk;
  }

  const sent = reachGoal(METRIKA_GOALS.vcPurchaseSuccess);
  console.log("[Goal] vc_purchase_success fired", { type: "vc", sent });
  return sent;
}

export function usePaymentGoal() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const hit = resolvePaymentGoalFromSearchParams(searchParams);
    if (!hit) return;

    const invId = searchParams.get("InvId") || searchParams.get("invid") || "";
    const storageKey = goalStorageKey(hit, invId);
    if (alreadyFired(storageKey)) {
      clearPaymentQuery();
      return;
    }

    let cancelled = false;

    const run = async () => {
      const ready = await waitForMetrika();
      if (cancelled) return;

      if (!ready) {
        console.log("[Goal] skipped, ym not ready after wait", hit);
        return;
      }

      const sent = firePaymentGoal(hit);
      if (!sent) return;

      markFired(storageKey);
      clearPaymentQuery();
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);
}

export function PaymentGoalTracker() {
  usePaymentGoal();
  return null;
}
