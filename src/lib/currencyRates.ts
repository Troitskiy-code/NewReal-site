import fs from "fs";
import os from "os";
import path from "path";

const CACHE_TTL = 24 * 60 * 60 * 1000;
const CBR_URL = "https://www.cbr.ru/scripts/XML_daily.asp";
const FALLBACK_USD = 90;
const FALLBACK_EUR = 100;

export type CurrencyRates = {
  USD: number;
  EUR: number;
  updatedAt: string;
};

const CACHE_PATHS = [
  path.join(process.cwd(), ".currency-cache.json"),
  path.join(os.tmpdir(), "newverse-currency-cache.json"),
];

let memoryCache: CurrencyRates | null = null;

function isPlausibleRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 20 && value < 500;
}

function isValidRates(value: unknown): value is CurrencyRates {
  if (!value || typeof value !== "object") return false;
  const rates = value as CurrencyRates;
  return (
    isPlausibleRate(rates.USD) &&
    isPlausibleRate(rates.EUR) &&
    typeof rates.updatedAt === "string" &&
    Number.isFinite(new Date(rates.updatedAt).getTime())
  );
}

function cacheAgeMs(updatedAt: string): number {
  return Date.now() - new Date(updatedAt).getTime();
}

function isFresh(rates: CurrencyRates): boolean {
  return cacheAgeMs(rates.updatedAt) < CACHE_TTL;
}

function readFileCache(): CurrencyRates | null {
  for (const file of CACHE_PATHS) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (isValidRates(parsed)) return parsed;
    } catch {
      // Missing or unreadable cache file.
    }
  }
  return null;
}

function writeFileCache(rates: CurrencyRates): void {
  const payload = JSON.stringify(rates, null, 2);
  let written = false;
  for (const file of CACHE_PATHS) {
    try {
      fs.writeFileSync(file, payload);
      written = true;
      break;
    } catch {
      // Read-only filesystem (e.g. some serverless hosts). Try the next path.
    }
  }
  if (!written) {
    console.warn("[Currency] Could not persist rates cache to disk");
  }
}

function parseCbrRate(xml: string, charCode: string): number | null {
  const block = xml
    .split(/<\/Valute>/i)
    .find((item) => item.includes(`<CharCode>${charCode}</CharCode>`));
  if (!block) return null;
  const nominalMatch = block.match(/<Nominal>(\d+)<\/Nominal>/);
  const valueMatch = block.match(/<Value>([\d,]+)<\/Value>/);
  if (!valueMatch) return null;
  const nominal = Number(nominalMatch?.[1] ?? 1) || 1;
  const value = parseFloat(valueMatch[1].replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  const perUnit = value / nominal;
  return isPlausibleRate(perUnit) ? perUnit : null;
}

async function fetchCbrRates(): Promise<CurrencyRates> {
  const response = await fetch(CBR_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`CBR responded with ${response.status}`);
  }

  const xml = await response.text();
  const usd = parseCbrRate(xml, "USD");
  const eur = parseCbrRate(xml, "EUR");
  if (!usd || !eur) {
    throw new Error("CBR XML did not contain USD and EUR rates");
  }

  return { USD: usd, EUR: eur, updatedAt: new Date().toISOString() };
}

export async function getCurrencyRates(options?: {
  forceRefresh?: boolean;
}): Promise<CurrencyRates> {
  const forceRefresh = options?.forceRefresh === true;

  if (!forceRefresh && memoryCache && isFresh(memoryCache)) {
    console.log(`[Currency] Using cached rates from ${memoryCache.updatedAt}`);
    return memoryCache;
  }

  if (!forceRefresh) {
    const fileCache = readFileCache();
    if (fileCache && isFresh(fileCache)) {
      memoryCache = fileCache;
      console.log(`[Currency] Using cached rates from ${fileCache.updatedAt}`);
      return fileCache;
    }
    if (fileCache) {
      memoryCache = fileCache;
    }
  }

  try {
    const rates = await fetchCbrRates();
    memoryCache = rates;
    writeFileCache(rates);
    console.log(`[Currency] Rates updated: USD=${rates.USD}, EUR=${rates.EUR}`);
    return rates;
  } catch (error) {
    const stale = memoryCache ?? readFileCache();
    if (stale) {
      console.error("[Currency] Failed to fetch rates from CBR, using stale cache:", error);
      memoryCache = stale;
      return stale;
    }

    console.error("[Currency] Failed to fetch rates from CBR, using fallback:", error);
    const fallback: CurrencyRates = {
      USD: FALLBACK_USD,
      EUR: FALLBACK_EUR,
      updatedAt: new Date().toISOString(),
    };
    memoryCache = fallback;
    return fallback;
  }
}
