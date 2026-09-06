export type Currency = "RUB" | "USD" | "EUR";

export const CURRENCIES: Currency[] = ["RUB", "USD", "EUR"];
export const DEFAULT_CURRENCY: Currency = "RUB";
export const PREFERRED_CURRENCY_KEY = "preferredCurrency";

function envRate(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// 1 USD = N RUB, 1 EUR = N RUB (overridable via NEXT_PUBLIC_ env)
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

export function getCurrencySymbol(currency: Currency): string {
  if (currency === "RUB") return "₽";
  if (currency === "USD") return "$";
  if (currency === "EUR") return "€";
  return "₽";
}
