export type Currency = "RUB" | "USD" | "EUR";

export const CURRENCIES: Currency[] = ["RUB", "USD", "EUR"];
export const DEFAULT_CURRENCY: Currency = "RUB";
export const PREFERRED_CURRENCY_KEY = "preferredCurrency";

function envRate(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const RUB_TO_USD = envRate("NEXT_PUBLIC_RUB_TO_USD", 90);
const RUB_TO_EUR = envRate("NEXT_PUBLIC_RUB_TO_EUR", 100);

export function isCurrency(value: unknown): value is Currency {
  return value === "RUB" || value === "USD" || value === "EUR";
}

export function convertPrice(priceInRUB: number, currency: Currency): number {
  if (currency === "RUB") return priceInRUB;
  if (currency === "USD") return priceInRUB / RUB_TO_USD;
  if (currency === "EUR") return priceInRUB / RUB_TO_EUR;
  return priceInRUB;
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

export function formatPriceFromRUB(priceInRUB: number, currency: Currency): string {
  return formatPrice(convertPrice(priceInRUB, currency), currency);
}

/** Display-only converted amount. Robokassa always charges the RUB price. */
export function convertPaymentAmount(priceInRUB: number, currency: Currency): number {
  return Number(convertPrice(priceInRUB, currency).toFixed(2));
}

/** Display-only USD/EUR equivalent. Returns null for RUB so the UI can hide the extra line. */
export function formatCbrEquivalent(priceInRUB: number, currency: Currency): string | null {
  if (currency === "RUB") return null;
  const amount = convertPaymentAmount(priceInRUB, currency);
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
