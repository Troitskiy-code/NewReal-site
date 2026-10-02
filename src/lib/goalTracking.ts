"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { trackOAuthLogin } from "@/lib/oauthLoginGoal";
import {
  captureInvoiceFromUrl,
  extractInvoiceIdFromLocation,
  listPendingPurchases,
  pollAndDispatchInvoice,
  setPurchaseTrackerUser,
  shouldContinuePolling,
} from "@/lib/purchaseGoalRuntime";

export function usePaymentGoal() {
  const { data, status } = useSession();
  const userId = data?.user?.id ?? null;
  const oauthLoginEventId = data?.user?.oauthLoginEventId;
  useEffect(() => {
    if (status !== "authenticated" || !oauthLoginEventId) return;
    return trackOAuthLogin(oauthLoginEventId);
  }, [status, oauthLoginEventId]);

  useEffect(() => {
    if (status === "loading") return;
    setPurchaseTrackerUser(status === "authenticated" ? userId : null);
  }, [status, userId]);

  useEffect(() => {
    if (status === "loading") return;
    captureInvoiceFromUrl();

    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      const ids = new Set(listPendingPurchases().map((item) => item.invoiceId));
      const fromUrl = extractInvoiceIdFromLocation();
      if (fromUrl) ids.add(fromUrl);
      for (const id of ids) {
        if (cancelled) return;
        await pollAndDispatchInvoice(id);
      }
      if (cancelled) return;
      if (listPendingPurchases().some(shouldContinuePolling)) {
        timer = window.setTimeout(() => {
          void tick();
        }, 2000);
      }
    };

    void tick();
    const resume = () => {
      if (timer) window.clearTimeout(timer);
      void tick();
    };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, [status, userId]);
}

export function PaymentGoalTracker() {
  usePaymentGoal();
  return null;
}
