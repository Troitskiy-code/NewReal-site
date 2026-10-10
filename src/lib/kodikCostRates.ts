import snapshot from "./data/kodik-cost-rates-2026-10-08.json";
import aliases from "./data/kodik-model-aliases.json";
import { TESTING_CHAT_MODELS } from "./testingChatModels";
import { finiteNonnegative } from "./aiCostMath";

export function canonicalKodikModel(model: string): string {
  return Object.hasOwn(aliases, model) ? aliases[model as keyof typeof aliases] : model;
}

type CatalogRates = { pricePer1MInput?: number | null; pricePer1MOutput?: number | null };
export function getKodikCostRates(model: string, catalog?: CatalogRates | null) {
  const canonical = canonicalKodikModel(model);
  let override: { input?: number; output?: number } | null = null;
  try {
    const configured = JSON.parse(process.env['AI_COST_RATES_RUB_JSON'] || "{}");
    override = configured[model] ?? configured[canonical] ?? null;
  } catch { /* Malformed optional configuration must not interrupt AI replies. */ }
  const quoted = (snapshot.rates as Record<string, { input: number; output: number }>)[canonical];
  const testingQuote = TESTING_CHAT_MODELS.find((entry) => entry.name === canonical);
  return {
    input: finiteNonnegative(override?.input) ?? finiteNonnegative(catalog?.pricePer1MInput) ?? quoted?.input ?? testingQuote?.pricePer1MInput ?? null,
    output: finiteNonnegative(override?.output) ?? finiteNonnegative(catalog?.pricePer1MOutput) ?? quoted?.output ?? testingQuote?.pricePer1MOutput ?? null,
  };
}
