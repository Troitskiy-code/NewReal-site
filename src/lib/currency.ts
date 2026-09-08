export type Currency = "RUB" | "USD" | "EUR";

export const CURRENCIES: Currency[] = ["RUB", "USD", "EUR"];
export const DEFAULT_CURRENCY: Currency = "RUB";
export const PREFERRED_CURRENCY_KEY = "preferredCurrency";

export type CbrRates = {
  USD: number;
  EUR: number;
};

export const FALLBACK_RATES: CbrRates = { USD: 90, EUR: 100 };

export function isCurrency(value: unknown): value is Currency {
  return value === "RUB" || value === "USD" || value === "EUR";
}

export function convertPrice(
  priceInRUB: number,
  currency: Currency,
  rates: CbrRates = FALLBACK_RATES
): number {
  if (currency === "RUB") return priceInRUB;
  const rate = currency === "USD" ? rates.USD : currency === "EUR" ? rates.EUR : 0;
  if (!rate || rate <= 0) return priceInRUB;
  return priceInRUB / rate;
}

export function formatPrice(price: number, currency: Currency): string {
  const formatter = new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return formatter.format(price);
}

export function formatPriceFromRUB(
  priceInRUB: number,
  currency: Currency,
  rates: CbrRates = FALLBACK_RATES
): string {
  return formatPrice(convertPrice(priceInRUB, currency, rates), currency);
}

/** Display-only converted amount. Robokassa always charges the RUB price. */
export function convertPaymentAmount(
  priceInRUB: number,
  currency: Currency,
  rates: CbrRates = FALLBACK_RATES
): number {
  return Number(convertPrice(priceInRUB, currency, rates).toFixed(2));
}

/** Display-only USD/EUR equivalent. Returns null for RUB so the UI can hide the extra line. */
export function formatCbrEquivalent(
  priceInRUB: number,
  currency: Currency,
  rates: CbrRates = FALLBACK_RATES
): string | null {
  if (currency === "RUB") return null;
  const amount = convertPaymentAmount(priceInRUB, currency, rates);
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function resolveCurrency(...candidates: unknown[]): Currency {
  for (const value of candidates) {
    if (isCurrency(value)) return value;
  }
  return DEFAULT_CURRENCY;
}

export function getCurrencySymbol(currency: Currency): string {
  if (currency === "RUB") return "₽";
  if (currency === "USD") return "$";
  if (currency === "EUR") return "€";
  return "₽";
}

export function getPreferredCurrency(): Currency {
  if (typeof window === "undefined") return DEFAULT_CURRENCY;
  try {
    const saved = localStorage.getItem(PREFERRED_CURRENCY_KEY);
    return isCurrency(saved) ? saved : DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
}

export function setPreferredCurrency(currency: Currency): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PREFERRED_CURRENCY_KEY, currency);
  } catch {
    // Ignore storage access errors (private mode, disabled storage).
  }
  document.cookie = `${PREFERRED_CURRENCY_KEY}=${currency}; path=/; max-age=31536000; samesite=lax`;
}
