"use client";

import { useCurrency } from "@/components/CurrencyContext";
import { convertPrice, formatPrice } from "@/lib/currency";

type ConvertedPriceProps = {
  amountRub: number;
  className?: string;
};

export default function ConvertedPrice({ amountRub, className }: ConvertedPriceProps) {
  const { currency, rates, ratesReady } = useCurrency();

  if (currency !== "RUB" && !ratesReady) {
    return (
      <span
        className={`inline-block h-[1em] w-[5.5ch] animate-pulse rounded bg-white/10 align-middle ${className ?? ""}`}
        aria-hidden
      />
    );
  }

  return <span className={className}>{formatPrice(convertPrice(amountRub, currency, rates), currency)}</span>;
}
