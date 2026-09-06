"use client";

import { useTranslation } from "react-i18next";
import { CURRENCIES, setPreferredCurrency, type Currency } from "@/lib/currency";

type CurrencySelectorProps = {
  value: Currency;
  onChange: (currency: Currency) => void;
  className?: string;
};

export default function CurrencySelector({
  value,
  onChange,
  className = "",
}: CurrencySelectorProps) {
  const { t } = useTranslation();

  const select = (currency: Currency) => {
    if (currency === value) return;
    setPreferredCurrency(currency);
    onChange(currency);
  };

  return (
    <div
      className={`inline-flex rounded-wd-pill border border-wd-border bg-wd-card p-1 ${className}`}
      aria-label={t("currency.label")}
    >
      {CURRENCIES.map((code) => {
        const active = value === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => select(code)}
            aria-pressed={active}
            className={`rounded-wd-pill px-4 py-2 text-sm font-bold uppercase tracking-wide transition-all ${
              active
                ? "bg-wd-secondary text-white shadow"
                : "text-wd-text-secondary hover:text-white"
            }`}
          >
            {code}
          </button>
        );
      })}
    </div>
  );
}
