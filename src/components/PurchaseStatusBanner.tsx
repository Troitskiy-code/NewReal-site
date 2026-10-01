"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";
import { normalizeInvId, type PaymentConfirmationStatus } from "@/lib/paymentStatus";

export function usePurchaseConfirmation(): {
  status: PaymentConfirmationStatus;
  invId: string | null;
} {
  const { status: sessionStatus } = useSession();
  const searchParams = useSearchParams();
  const invId = normalizeInvId(searchParams.get("InvId") || searchParams.get("invid"));
  const paymentHint = searchParams.get("payment") === "success" || Boolean(invId);
  const [status, setStatus] = useState<PaymentConfirmationStatus>(
    paymentHint && invId ? "pending" : "idle"
  );

  useEffect(() => {
    if (!invId || sessionStatus !== "authenticated") {
      if (!paymentHint) setStatus("idle");
      return;
    }

    let cancelled = false;
    let attempts = 0;

    const poll = async () => {
      try {
        const res = await fetch(`/api/payment/status?invId=${encodeURIComponent(invId)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { status?: PaymentConfirmationStatus };
        if (cancelled) return;
        if (data.status === "confirmed" || data.status === "pending" || data.status === "idle") {
          setStatus(data.status === "idle" ? "pending" : data.status);
        }
      } catch {
        /* keep pending */
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      attempts += 1;
      if (attempts > 15) {
        window.clearInterval(timer);
        setStatus((current) => (current === "confirmed" ? current : "waiting"));
        return;
      }
      void poll();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [invId, paymentHint, sessionStatus]);

  return { status, invId };
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
