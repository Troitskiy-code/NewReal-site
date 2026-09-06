"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_CURRENCY,
  PREFERRED_CURRENCY_KEY,
  isCurrency,
  type Currency,
} from "@/lib/currency";

type CurrencyContextValue = {
  currency: Currency;
  setCurrency: (currency: Currency) => void;
};

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const [currency, setCurrencyState] = useState<Currency>(DEFAULT_CURRENCY);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PREFERRED_CURRENCY_KEY);
      if (isCurrency(stored)) {
        setCurrencyState(stored);
      }
    } catch {
      // Ignore storage access errors (private mode, disabled storage).
    }
  }, []);

  const setCurrency = useCallback((next: Currency) => {
    setCurrencyState(next);
    try {
      window.localStorage.setItem(PREFERRED_CURRENCY_KEY, next);
    } catch {
      // Ignore storage access errors (private mode, disabled storage).
    }
  }, []);

  const value = useMemo(() => ({ currency, setCurrency }), [currency, setCurrency]);

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext);
  if (!ctx) {
    throw new Error("useCurrency must be used within CurrencyProvider");
  }
  return ctx;
}
