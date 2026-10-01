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
      if (invId) {
        let confirmed = false;
        for (let i = 0; i < 12; i += 1) {
          try {
            const res = await fetch(`/api/payment/status?invId=${encodeURIComponent(invId)}`);
            if (res.ok) {
              const data = (await res.json()) as { status?: string };
              if (data.status === "confirmed") {
                confirmed = true;
                break;
              }
            }
          } catch {
            /* keep polling */
          }
          await new Promise((resolve) => window.setTimeout(resolve, 2000));
          if (cancelled) return;
        }
        if (!confirmed) {
          console.log("[Goal] skipped, payment not confirmed yet", hit, invId);
          return;
        }
      } else {
        console.log("[Goal] skipped, no InvId to confirm", hit);
        return;
      }

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
