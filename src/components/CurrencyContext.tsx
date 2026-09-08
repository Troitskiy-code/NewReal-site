"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_CURRENCY,
  FALLBACK_RATES,
  getPreferredCurrency,
  setPreferredCurrency,
  type CbrRates,
  type Currency,
} from "@/lib/currency";

type CurrencyRatesState = CbrRates & { updatedAt: string | null };

type CurrencyContextValue = {
  currency: Currency;
  setCurrency: (currency: Currency) => void;
  rates: CbrRates;
  ratesReady: boolean;
  ratesUpdatedAt: string | null;
};

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const [currency, setCurrencyState] = useState<Currency>(DEFAULT_CURRENCY);
  const [rates, setRates] = useState<CurrencyRatesState>({
    ...FALLBACK_RATES,
    updatedAt: null,
  });
  const [ratesReady, setRatesReady] = useState(false);

  useEffect(() => {
    const stored = getPreferredCurrency();
    setCurrencyState(stored);
    setPreferredCurrency(stored);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadRates = async () => {
      try {
        const res = await fetch("/api/currency/rates", { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (typeof data?.USD === "number" && typeof data?.EUR === "number") {
          setRates({
            USD: data.USD,
            EUR: data.EUR,
            updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
          });
        }
      } catch (error) {
        console.error("[Currency] Failed to load CBR rates", error);
      } finally {
        if (!cancelled) setRatesReady(true);
      }
    };

    void loadRates();
    return () => {
      cancelled = true;
    };
  }, []);

  const setCurrency = useCallback((next: Currency) => {
    setPreferredCurrency(next);
    setCurrencyState(next);
  }, []);

  const value = useMemo(
    () => ({
      currency,
      setCurrency,
      rates: { USD: rates.USD, EUR: rates.EUR },
      ratesReady,
      ratesUpdatedAt: rates.updatedAt,
    }),
    [currency, rates.EUR, rates.USD, rates.updatedAt, ratesReady, setCurrency]
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext);
  if (!ctx) {
    throw new Error("useCurrency must be used within CurrencyProvider");
  }
  return ctx;
}
