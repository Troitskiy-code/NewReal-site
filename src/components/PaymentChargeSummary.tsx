"use client";

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useCurrency } from "@/components/CurrencyContext";
import { formatCbrEquivalent, formatPrice } from "@/lib/currency";

type PaymentChargeSummaryProps = {
  amountRub: number;
  context?: string;
};

export default function PaymentChargeSummary({
  amountRub,
  context = "payment",
}: PaymentChargeSummaryProps) {
  const { t } = useTranslation();
  const { currency, rates, ratesReady } = useCurrency();
  const equivalent =
    currency !== "RUB" && ratesReady ? formatCbrEquivalent(amountRub, currency, rates) : null;

  useEffect(() => {
    console.log("[Payment] Charge preview", {
      context,
      amountRUB: amountRub,
      displayCurrency: currency,
      equivalent,
      ratesReady,
      rates,
    });
  }, [amountRub, context, currency, equivalent, rates, ratesReady]);

  return (
    <div className="rounded-wd border border-wd-border bg-[#0A0A0A] px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-wd-text-secondary">
        {t("payment.chargeLabel")}
      </p>
      <p className="mt-1 text-2xl font-black leading-none text-white">
        {formatPrice(amountRub, "RUB")}
      </p>
      {currency !== "RUB" && !ratesReady && (
        <p className="mt-1.5 text-xs text-wd-text-secondary">{t("payment.ratesLoading")}</p>
      )}
      {equivalent && (
        <p className="mt-1.5 text-xs text-wd-text-secondary">
          {t("payment.cbrEquivalent", { amount: equivalent })}
        </p>
      )}
    </div>
  );
}
