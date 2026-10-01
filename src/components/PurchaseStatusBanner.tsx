"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";
import type { PaymentConfirmationStatus } from "@/lib/paymentStatus";
import {
  captureInvoiceFromUrl,
  clonePurchaseRecord,
  confirmationStatusOf,
  resolveBannerRecord,
  setPurchaseTrackerUser,
  subscribePurchaseRecord,
  type PendingPurchaseRecord,
} from "@/lib/purchaseGoalRuntime";

export function usePurchaseConfirmation(): {
  status: PaymentConfirmationStatus;
  invId: string | null;
} {
  const { data, status: sessionStatus } = useSession();
  const userId = data?.user?.id ?? null;
  const [record, setRecord] = useState<PendingPurchaseRecord | null>(null);

  useEffect(() => {
    if (sessionStatus === "loading") return;
    setPurchaseTrackerUser(sessionStatus === "authenticated" ? userId : null);
    const unsubscribe = subscribePurchaseRecord((next) => {
      setRecord(next ? clonePurchaseRecord(next) : null);
    });
    captureInvoiceFromUrl();
    return unsubscribe;
  }, [sessionStatus, userId]);

  const displayed = record ?? resolveBannerRecord();
  return {
    status: confirmationStatusOf(displayed),
    invId: displayed?.invoiceId ?? null,
  };
}

export function PurchaseStatusBanner({ ns = "payment" }: { ns?: "payment" | "coins" | "pricing" }) {
  const { t } = useTranslation();
  const { status } = usePurchaseConfirmation();

  if (status === "idle") return null;

  const pendingKey = ns === "payment" ? "payment.pending" : `${ns}.paymentPending`;
  const confirmedKey = ns === "payment" ? "payment.confirmed" : `${ns}.paymentConfirmed`;
  const waitingKey = ns === "payment" ? "payment.unknown" : `${ns}.paymentPending`;

  return (
    <div
      className={`rounded-wd border px-4 py-3 text-center text-sm ${
        status === "confirmed"
          ? "border-wd-secondary/40 bg-wd-card text-white"
          : "border-wd-border bg-wd-card text-wd-text-secondary"
      }`}
    >
      {status === "confirmed" ? t(confirmedKey) : status === "waiting" ? t(waitingKey) : t(pendingKey)}
      {status === "waiting" ? (
        <>
          {" "}
          <a href="/support?topic=payment" className="text-wd-secondary underline">
            {t("footer.support")}
          </a>
        </>
      ) : null}
    </div>
  );
}
