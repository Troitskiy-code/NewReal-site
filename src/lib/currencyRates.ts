import { errorLog, toSafeDiagnostic } from "@/lib/logger";
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
  source?: "cbr" | "fallback";
  rateDate?: string;
};

const CACHE_PATHS = [
  path.join(/* turbopackIgnore: true */ process.cwd(), ".currency-cache.json"),
  path.join(os.tmpdir(), "newverse-currency-cache.json"),
];

let memoryCache: CurrencyRates | null = null;
let refreshInFlight: Promise<CurrencyRates> | null = null;

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
  const age = cacheAgeMs(rates.updatedAt);
  return age >= 0 && age < CACHE_TTL;
}

// A display fallback or a legacy cache without provenance is never accounting FX.
export function isAccountingCurrencyRate(rates: CurrencyRates, now = Date.now()): boolean {
  const age = now - Date.parse(rates.updatedAt);
  const rateDay = Date.parse(`${rates.rateDate}T00:00:00Z`);
  return isValidRates(rates) && rates.source === "cbr" && age >= 0 && age < CACHE_TTL
    && /^\d{4}-\d{2}-\d{2}$/.test(rates.rateDate ?? "") && Number.isFinite(rateDay)
    && rateDay <= now + 86400000 && now - rateDay < 10 * 86400000;
}

export async function getAccountingUsdRub(): Promise<number | null> {
  // Chat accounting never waits for external FX HTTP. Cron/the display endpoint
  // refresh the shared cache; missing or pre-provenance caches use catalog estimates.
  const rates = memoryCache && isAccountingCurrencyRate(memoryCache) ? memoryCache : readFileCache();
  return rates && isAccountingCurrencyRate(rates) ? rates.USD : null;
}

function readFileCache(): CurrencyRates | null {
  for (const file of CACHE_PATHS) {
    try {
      // This cache is generated at runtime. Do not trace the project/tmp directory into deploy artifacts.
      const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8"));
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
    errorLog("Server", "[Currency] Could not persist rates cache to disk");
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

  const date = xml.match(/<ValCurs\b[^>]*\bDate=["'](\d{2})\.(\d{2})\.(\d{4})["']/i);
  if (!date) throw new Error("CBR XML did not contain a rate date");
  const rateDate = `${date[3]}-${date[2]}-${date[1]}`;
  if (new Date(`${rateDate}T00:00:00Z`).toISOString().slice(0, 10) !== rateDate) {
    throw new Error("Invalid CBR rate date");
  }
  return { USD: usd, EUR: eur, updatedAt: new Date().toISOString(), source: "cbr", rateDate };
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

  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshRates();
  try { return await refreshInFlight; }
  finally { refreshInFlight = null; }
}

async function refreshRates(): Promise<CurrencyRates> {
  try {
    const rates = await fetchCbrRates();
    memoryCache = rates;
    writeFileCache(rates);
    console.log(`[Currency] Rates updated: USD=${rates.USD}, EUR=${rates.EUR}`);
    return rates;
  } catch (error) {
    const stale = memoryCache ?? readFileCache();
    if (stale) {
      errorLog("Server", "[Currency] Failed to fetch rates from CBR, using stale cache:", toSafeDiagnostic(error));
      memoryCache = stale;
      return stale;
    }

    errorLog("Server", "[Currency] Failed to fetch rates from CBR, using fallback:", toSafeDiagnostic(error));
    const fallback: CurrencyRates = {
      USD: FALLBACK_USD,
      EUR: FALLBACK_EUR,
      updatedAt: new Date().toISOString(),
      source: "fallback",
    };
    memoryCache = fallback;
    return fallback;
  }
}
