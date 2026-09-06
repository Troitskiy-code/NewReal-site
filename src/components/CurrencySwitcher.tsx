"use client";

import { useTranslation } from "react-i18next";
import { useCurrency } from "./CurrencyContext";
import { CURRENCIES } from "@/lib/currency";

export default function CurrencySwitcher({ className = "" }: { className?: string }) {
  const { currency, setCurrency } = useCurrency();
  const { t } = useTranslation();

  return (
    <div className={`inline-flex items-center gap-1 ${className}`} aria-label={t("currency.label")}>
      {CURRENCIES.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setCurrency(code)}
          className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide transition-colors ${
            currency === code
              ? "bg-white/10 text-white"
              : "text-[#A0A0A0] hover:text-white"
          }`}
          aria-pressed={currency === code}
        >
          {t(`currency.${code}`)}
        </button>
      ))}
    </div>
  );
}
