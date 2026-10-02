/**
 * Parameterized acquisition/retention calculator. Does not change live prices.
 * node --experimental-strip-types scripts/economy-acquisition.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUBSCRIPTION_PLANS } from "../src/lib/chatEconomy.ts";
import { weightedRequestEconomy } from "../src/lib/aiCostMath.ts";
import { shouldPersistEmbeddings } from "../src/lib/ragEligibility.ts";

type Status = "measurement" | "contract" | "assumption";
type Scenario = "low" | "medium" | "high" | "stress";

const AS_OF = "2026-10-02";
const avatarAllowance = (price: number) => Math.floor(price * 0.1 / 5);
const observed = process.env.ECONOMY_COST_REPORT ? JSON.parse(readFileSync(process.env.ECONOMY_COST_REPORT, "utf8")) : null;
if (observed && (!Array.isArray(observed.models) || !observed.models.length)) throw new Error("Cost report contains no models");

const params = {
  livePlans: {
    value: SUBSCRIPTION_PLANS.map((plan) => ({
      id: plan.id,
      monthlyPrice: plan.monthlyPrice,
      yearlyPrice: plan.yearlyPrice,
      vcPerMonth: plan.vcPerMonth,
    })),
    source: "src/lib/chatEconomy.ts",
    date: AS_OF,
    status: "contract" as Status,
  },
  acquiringPct: {
    value: 0.039,
    source: "docs/universe-subscription-economy-report.md (not a live merchant statement)",
    date: "2026-09-30",
    status: "assumption" as Status,
  },
  taxPct: {
    value: 0.06,
    source: "placeholder USN 6%; replace with actual tax regime before a live experiment",
    date: AS_OF,
    status: "assumption" as Status,
  },
  infraMonthlyRub: {
    value: 25_000,
    source: "unmeasured hosting/support floor; not telemetry",
    date: AS_OF,
    status: "assumption" as Status,
  },
  cheapInputRubPer1M: { value: 7.22, source: "RUB/1M input, historical quote 2026-09-24; not a current invoice", date: AS_OF, status: "assumption" as Status },
  dearInputRubPer1M: { value: 105, source: "RUB/1M input, historical quote 2026-09-24; not a current invoice", date: AS_OF, status: "assumption" as Status },
  tokensInPerRequest: {
    value: { low: 1_200, medium: 2_400, high: 6_000, stress: 16_000 },
    source: "unmeasured; do not treat as product p50/p95",
    date: AS_OF,
    status: "assumption" as Status,
  },
  tokensOutPerRequest: {
    value: { low: 400, medium: 900, high: 1_000, stress: 1_000 },
    source: "unmeasured",
    date: AS_OF,
    status: "assumption" as Status,
  },
  cheapVc: { value: 4, source: "historical catalog snapshot in universe-subscription-economy-report.md", date: "2026-09-24", status: "assumption" as Status },
  dearVc: { value: 36, source: "historical catalog snapshot in universe-subscription-economy-report.md", date: "2026-09-24", status: "assumption" as Status },
  retryFactor: { value: { low: 1.02, medium: 1.08, high: 1.2, stress: 1.45 }, source: "unmeasured provider retry load", date: AS_OF, status: "assumption" as Status },
  ragExtraFactor: {
    value: { low: 1.05, medium: 1.15, high: 1.3, stress: 1.6 },
    source: "RAG embeddings persist for eligible paid plans even if ENABLE_RAG_EMBEDDINGS=false",
    date: AS_OF,
    status: "assumption" as Status,
  },
  supportTicketsPerPayer: {
    value: { low: 0.03, medium: 0.08, high: 0.18, stress: 0.4 },
    source: "unmeasured",
    date: AS_OF,
    status: "assumption" as Status,
  },
  supportRubPerTicket: { value: 90, source: "unmeasured ops cost", date: AS_OF, status: "assumption" as Status },
  refundPct: { value: { low: 0.01, medium: 0.03, high: 0.06, stress: 0.12 }, source: "unmeasured", date: AS_OF, status: "assumption" as Status },
  visitors: { value: { low: 2_000, medium: 8_000, high: 20_000, stress: 50_000 }, source: "unmeasured monthly visitors", date: AS_OF, status: "assumption" as Status },
  cacRub: { value: { low: 70, medium: 160, high: 320, stress: 650 }, source: "unmeasured paid CAC", date: AS_OF, status: "assumption" as Status },
};

const SCENARIOS: Scenario[] = ["low", "medium", "high", "stress"];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function requestEconomy(scenario: Scenario, dearShare: number) {
  const inputTokens = params.tokensInPerRequest.value[scenario];
  const outputTokens = params.tokensOutPerRequest.value[scenario];
  if (observed) {
    const models = observed.models.filter((m: { purpose: string; completed: number }) => m.purpose === "chat" && m.completed > 0);
    const total = models.reduce((sum: number, m: { completed: number }) => sum + m.completed, 0);
    if (!total) throw new Error("No completed chat attempts in cost report");
    return weightedRequestEconomy(models.map((m: { completed: number; providerCompletedUsageCount: number; priceVC: number; inputRubPerMillion: number; outputRubPerMillion: number; averageInputTokens: number; averageOutputTokens: number; p50InputTokens: number; p50OutputTokens: number; p95InputTokens: number; p95OutputTokens: number }) => {
      if (m.priceVC == null || m.inputRubPerMillion == null || m.outputRubPerMillion == null) throw new Error("Missing catalog prices in cost report; supply verified rates first");
      if (m.providerCompletedUsageCount / m.completed < 0.9 || m.averageInputTokens == null || m.averageOutputTokens == null) throw new Error("Insufficient provider usage coverage; do not label estimated tokens as measurements");
      const measuredInput = scenario === "low" ? m.p50InputTokens : scenario === "medium" ? m.averageInputTokens : scenario === "high" ? m.p95InputTokens : Math.max(m.p95InputTokens, 16000);
      const measuredOutput = scenario === "low" ? m.p50OutputTokens : scenario === "medium" ? m.averageOutputTokens : scenario === "high" ? m.p95OutputTokens : Math.max(m.p95OutputTokens, 1000);
      return { requestShare: m.completed / total, vc: m.priceVC, inputRubPerMillion: m.inputRubPerMillion,
        outputRubPerMillion: m.outputRubPerMillion, inputTokens: measuredInput, outputTokens: measuredOutput };
    }));
  }
  return weightedRequestEconomy([
    { requestShare: 1 - dearShare, vc: params.cheapVc.value, inputRubPerMillion: params.cheapInputRubPer1M.value,
      outputRubPerMillion: 14.44, inputTokens, outputTokens },
    { requestShare: dearShare, vc: params.dearVc.value, inputRubPerMillion: params.dearInputRubPer1M.value,
      outputRubPerMillion: 211, inputTokens, outputTokens },
  ]);
}
function aiRubPerRequest(scenario: Scenario, dearShare: number): number {
  return requestEconomy(scenario, dearShare).averageRub * params.retryFactor.value[scenario] * params.ragExtraFactor.value[scenario];
}

type VariantId = "control" | "guest10" | "daily20" | "premiumTrial" | "firstPack129";

type Variant = {
  id: VariantId;
  title: string;
  guestMessages: number;
  dailyFreeRequests: number;
  premiumTrials: number;
  firstPackRub: number;
  firstPackVc: number;
  conversionToAccount: Record<Scenario, number>;
  conversionToPayer: Record<Scenario, number>;
  repeatPayerShare: Record<Scenario, number>;
  dearShare: Record<Scenario, number>;
  paidPlanId: "dialog" | "story" | "universe";
  promoVcBurnShare: number;
};

const variants: Variant[] = [
  {
    id: "control",
    title: "Current tariffs with repaired first experience",
    guestMessages: 5,
    dailyFreeRequests: 0,
    premiumTrials: 0,
    firstPackRub: 0,
    firstPackVc: 0,
    conversionToAccount: { low: 0.04, medium: 0.07, high: 0.11, stress: 0.16 },
    conversionToPayer: { low: 0.012, medium: 0.025, high: 0.04, stress: 0.055 },
    repeatPayerShare: { low: 0.25, medium: 0.35, high: 0.45, stress: 0.2 },
    dearShare: { low: 0.05, medium: 0.15, high: 0.3, stress: 0.55 },
    paidPlanId: "universe",
    promoVcBurnShare: 0.04,
  },
  {
    id: "guest10",
    title: "Expanded guest trial: 10 messages on economical model",
    guestMessages: 10,
    dailyFreeRequests: 0,
    premiumTrials: 0,
    firstPackRub: 0,
    firstPackVc: 0,
    conversionToAccount: { low: 0.05, medium: 0.09, high: 0.14, stress: 0.2 },
    conversionToPayer: { low: 0.013, medium: 0.028, high: 0.046, stress: 0.06 },
    repeatPayerShare: { low: 0.24, medium: 0.34, high: 0.44, stress: 0.18 },
    dearShare: { low: 0.04, medium: 0.12, high: 0.28, stress: 0.5 },
    paidPlanId: "universe",
    promoVcBurnShare: 0.05,
  },
  {
    id: "daily20",
    title: "20 economical requests/day for verified accounts",
    guestMessages: 5,
    dailyFreeRequests: 20,
    premiumTrials: 0,
    firstPackRub: 0,
    firstPackVc: 0,
    conversionToAccount: { low: 0.05, medium: 0.1, high: 0.16, stress: 0.22 },
    conversionToPayer: { low: 0.01, medium: 0.022, high: 0.038, stress: 0.05 },
    repeatPayerShare: { low: 0.22, medium: 0.32, high: 0.42, stress: 0.16 },
    dearShare: { low: 0.04, medium: 0.12, high: 0.25, stress: 0.48 },
    paidPlanId: "story",
    promoVcBurnShare: 0.08,
  },
  {
    id: "premiumTrial",
    title: "3 one-shot premium model trials after signup",
    guestMessages: 5,
    dailyFreeRequests: 0,
    premiumTrials: 3,
    firstPackRub: 0,
    firstPackVc: 0,
    conversionToAccount: { low: 0.045, medium: 0.08, high: 0.13, stress: 0.18 },
    conversionToPayer: { low: 0.014, medium: 0.03, high: 0.05, stress: 0.065 },
    repeatPayerShare: { low: 0.26, medium: 0.36, high: 0.46, stress: 0.22 },
    dearShare: { low: 0.12, medium: 0.22, high: 0.4, stress: 0.65 },
    paidPlanId: "universe",
    promoVcBurnShare: 0.06,
  },
  {
    id: "firstPack129",
    title: "One-time 129 ₽ pack without autorenew, then current subscription",
    guestMessages: 5,
    dailyFreeRequests: 0,
    premiumTrials: 0,
    firstPackRub: 129,
    firstPackVc: 0,
    conversionToAccount: { low: 0.045, medium: 0.08, high: 0.12, stress: 0.17 },
    conversionToPayer: { low: 0.02, medium: 0.04, high: 0.065, stress: 0.09 },
    repeatPayerShare: { low: 0.18, medium: 0.28, high: 0.4, stress: 0.15 },
    dearShare: { low: 0.05, medium: 0.14, high: 0.28, stress: 0.5 },
    paidPlanId: "dialog",
    promoVcBurnShare: 0.03,
  },
];

function planById(id: string) {
  return SUBSCRIPTION_PLANS.find((plan) => plan.id === id)!;
}

// One fixed SKU for every scenario, sized by the worst modeled RUB/VC.
// Leaves 50% gross revenue for non-AI expenses/contribution; still a hypothesis.
const FIRST_PACK_AI_BUDGET_RUB = 129 * 0.5;
const FIRST_PACK_VC = Math.floor(FIRST_PACK_AI_BUDGET_RUB / Math.max(...SCENARIOS.map(s =>
  Math.max(...[0, 0.5, 1].map(share => aiRubPerRequest(s, share) / requestEconomy(s, share).averageVc))
)));
if (!Number.isSafeInteger(FIRST_PACK_VC) || FIRST_PACK_VC <= 0) throw new Error("Pack has no affordable VC allowance");

type Row = {
  variant: VariantId;
  scenario: Scenario;
  visitors: number;
  accounts: number;
  payers: number;
  grossRevenue: number;
  discountsAndRefunds: number;
  netRevenue: number;
  variableCost: number;
  promoAiRub: number;
  paidRequests: number;
  fullBurnAiRub: number;
  avatarCostRub: number;
  firstPackVc: number;
  contribution: number;
  infraAndAcquisition: number;
  profit: number;
  contributionPerVisitor: number;
  contributionPerPayer: number;
  costPerActivatedUser: number;
  costPerPayer: number;
  carryoverLiabilityRub: number;
};

function evaluate(variant: Variant, scenario: Scenario): Row {
  const visitors = params.visitors.value[scenario];
  const accounts = visitors * variant.conversionToAccount[scenario];
  const payers = visitors * variant.conversionToPayer[scenario];
  const plan = planById(variant.paidPlanId);
  const packVc = variant.firstPackRub > 0 ? FIRST_PACK_VC : 0;
  const packPayers = variant.firstPackRub > 0 ? payers : 0;
  const subPayers = variant.firstPackRub > 0 ? payers * variant.repeatPayerShare[scenario] : payers;
  const grossRevenue = packPayers * variant.firstPackRub + subPayers * plan.monthlyPrice;
  const refunds = grossRevenue * params.refundPct.value[scenario];
  const netRevenue = grossRevenue - refunds;
  // Acquiring charged on gross; refunded fees are conservatively not recovered.
  const acquiring = grossRevenue * params.acquiringPct.value;
  const tax = netRevenue * params.taxPct.value;

  const cheapCost = aiRubPerRequest(scenario, 0);
  const mixedCost = aiRubPerRequest(scenario, variant.dearShare[scenario]);
  const guestCost = visitors * 0.35 * variant.guestMessages * cheapCost; // assumed 35% actually start a chat
  const dailyCost = accounts * variant.dailyFreeRequests * 12 * cheapCost; // assumed 12 active days
  const trialCost = accounts * variant.premiumTrials * aiRubPerRequest(scenario, 1);
  const packUsage = 0.75; // assumed fraction of purchased VC spent this observation period
  const subscriptionUsage = 0.8; // expiring VC consumed this month; full-burn risk also exported
  const mix = requestEconomy(scenario, variant.dearShare[scenario]);
  const rubPerVc = mixedCost / mix.averageVc;
  const packAi = packPayers * packVc * packUsage * rubPerVc;
  const paidRequests = subPayers * plan.vcPerMonth * subscriptionUsage / mix.averageVc;
  const paidAi = paidRequests * mixedCost;
  const promoAi = subPayers * plan.vcPerMonth * variant.promoVcBurnShare * rubPerVc;
  const images = subPayers * avatarAllowance(plan.monthlyPrice) * 5 * 0.5; // assumed 50% avatar utilization
  const support = payers * params.supportTicketsPerPayer.value[scenario] * params.supportRubPerTicket.value;
  const variableCost = guestCost + dailyCost + trialCost + packAi + paidAi + promoAi + images + support + acquiring + tax;
  const contribution = netRevenue - variableCost;
  const infraShare = params.infraMonthlyRub.value;
  const paidCac = params.cacRub.value[scenario] * payers;
  const profit = contribution - infraShare - paidCac;
  const carryoverLiabilityRub = packPayers * packVc * (1 - packUsage) * rubPerVc; // purchased VC only; subscription VC expires

  return {
    variant: variant.id,
    scenario,
    visitors: Math.round(visitors),
    accounts: Math.round(accounts),
    payers: Math.round(payers),
    grossRevenue: round2(grossRevenue),
    discountsAndRefunds: round2(refunds),
    netRevenue: round2(netRevenue),
    variableCost: round2(variableCost),
    promoAiRub: round2(promoAi),
    paidRequests: round2(paidRequests),
    fullBurnAiRub: round2(subPayers * plan.vcPerMonth * rubPerVc + promoAi + packPayers * packVc * rubPerVc),
    avatarCostRub: round2(images),
    firstPackVc: packVc,
    contribution: round2(contribution),
    infraAndAcquisition: round2(infraShare + paidCac),
    profit: round2(profit),
    contributionPerVisitor: round2(contribution / visitors),
    contributionPerPayer: round2(payers ? contribution / payers : 0),
    costPerActivatedUser: round2(accounts ? (guestCost + dailyCost + trialCost + paidCac) / accounts : 0),
    costPerPayer: round2(payers ? (variableCost + paidCac) / payers : 0),
    carryoverLiabilityRub: round2(carryoverLiabilityRub),
  };
}

function assert(condition: boolean, label: string) {
  if (!condition) throw new Error(`formula check failed: ${label}`);
}

const previousRag = process.env.ENABLE_RAG_EMBEDDINGS;
process.env.ENABLE_RAG_EMBEDDINGS = "false";
assert(shouldPersistEmbeddings("universe", true) === true, "RAG OR-flag for paid plans");
assert(shouldPersistEmbeddings("dialog", true) === true, "dialog RAG independent of global flag");
if (previousRag === undefined) delete process.env.ENABLE_RAG_EMBEDDINGS; else process.env.ENABLE_RAG_EMBEDDINGS = previousRag;

const rows = variants.flatMap((variant) => SCENARIOS.map((scenario) => evaluate(variant, scenario)));
for (const row of rows) {
  assert(Math.abs(row.netRevenue - (row.grossRevenue - row.discountsAndRefunds)) < 0.11, "net revenue identity");
  assert(Math.abs(row.profit - (row.contribution - row.infraAndAcquisition)) < 0.11, "profit identity");
}

const recommended = variants.find((item) => item.id === "firstPack129")!;
const recommendedMedium = evaluate(recommended, "medium");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonPath = join(root, "docs/universe-acquisition-economy.json");
const mdPath = join(root, "docs/universe-acquisition-economy.md");

const payload = {
  asOf: AS_OF,
  livePricesUnchanged: params.livePlans.value,
  parameters: params,
  measurementSource: observed ? { generatedAt: observed.generatedAt, from: observed.from, to: observed.to, coverage: observed.coverage } : null,
  assumptions: { guestActivationShare: 0.35, activeDays: 12, packUsage: 0.75, subscriptionUsage: 0.8, avatarUsage: 0.5, fixedFirstPackVc: FIRST_PACK_VC, firstPackAiBudgetRub: FIRST_PACK_AI_BUDGET_RUB },
  limitations: ["Conversion, CAC, tax, refunds, retry and auxiliary multipliers remain assumptions", "Cost report replaces mix/rates and low=p50, medium=mean, high=p95 token profiles; stress retains 16000 input/1000 output floor. >=90% completed provider usage required. Retry/RAG and conversion/CAC remain assumptions", "Avatar 5 RUB is a budget assumption; actual bill must be reconciled", "No forecast is guaranteed profit; unknown telemetry costs are not zero"],
  formula: {
    netRevenue: "grossRevenue - refunds (promo VC burn is an AI cost, not a second revenue haircut)",
    contribution: "netRevenue - variableCost(AI including retry/RAG/images/support/acquiring/tax)",
    profit: "contribution - infraMonthly - CAC_on_payers",
    rag: "shouldPersistEmbeddings = isRagEligible(paid active plan) OR ENABLE_RAG_EMBEDDINGS",
  },
  rows,
  extras: {
    unspentPurchasedVcLiabilityControl: evaluate(variants[0], "medium").carryoverLiabilityRub,
    imagePack: "Avatar quota uses 10% of nominal monthly plan price at an assumed 5 RUB per generation; every model consumes one generation. Existing usage is not reset.",
    referral: "Pay referral VC only after PaymentEvent confirmation; reverse on refund of the referred invoice.",
    authors: "Creator payouts stay on current contract. Acquisition experiments must not rewrite existing character revenue share.",
  },
  recommendation: {
    experiment: "firstPack129",
    hypothesis:
      "Hypothesis only: a 129 ₽ one-time pack with one fixed VC allowance sized against worst modeled cost/VC, without autorenew, may improve first payments. Not enabled; validate invoices and margins first.",
    audience: "New registered users who finished at least one guest reply, RU, desktop+mobile, 28 days plus one billing cycle watch.",
    budgetRub: 40_000,
    stop: "If confirmed first-pay conversion is below control by 20% relative, or support tickets/payer rise 2x, or contribution/visitor stays negative after 28 days AND the following monthly renewal window.",
    rollback: "Disable the SKU; keep already purchased packs; do not alter live subscription prices or paid entitlements.",
    sample: "Calculate sample size from observed baseline conversion, minimum detectable effect and chosen power before launch; observe at least one renewal window. No unmeasured fixed event count guarantees significance.",
    mediumProjection: recommendedMedium,
  },
};

writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);

const lines = [
  "# Acquisition economy calculation (not live prices)",
  "",
  `Date: ${AS_OF}. Live public prices stay Dialog 499 ₽ / 2 500 VC, Story 1 299 ₽ / 10 000 VC, Universe 3 499 ₽ / 30 000 VC.`,
  "",
  observed
    ? `Source: ${observed.from} to ${observed.to}. Model mix and token profiles come from completed provider usage; quoted RUB rates are estimates. Conversion/CAC/tax/retry/auxiliary load remain assumptions.`
    : "Generated by npm run economy:acquisition without a production cost report. Model/token inputs are historical quotes and assumptions, not observed costs. Feed an economy:costs JSON with ECONOMY_COST_REPORT when sufficient data exists.",
  "",
  "## Formulas",
  "",
  "- Net revenue = gross − refunds. Promo VC already burns AI; it is not subtracted again from revenue.",
  "- Contribution = net revenue − variable costs (model, retry, RAG, images, support, acquiring, tax).",
  "- Profit = contribution − infra − CAC attributed to payers.",
  "- RAG: paid eligible active subscriptions persist embeddings even when `ENABLE_RAG_EMBEDDINGS=false` (`isRagEligible OR flag`).",
  "",
  "## Results",
  "",
  "Hypothetical projections; these amounts are not measured profit.",
  ...rows.map(
    (row) =>
      `- ${row.variant}/${row.scenario}: contribution ${row.contribution} RUB; profit ${row.profit} RUB; promo AI ${row.promoAiRub} RUB; avatars ${row.avatarCostRub} RUB; unspent purchased VC liability ${row.carryoverLiabilityRub} RUB.`
  ),
  "",
  `Fixed proposed 129 RUB pack: ${FIRST_PACK_VC} VC. Assumptions: 35% guest activation, 12 active days, 80% subscription VC usage, 75% pack usage, 50% avatar quota usage. Model prices are historical RUB/1M quotes, not live invoices.`,
  "",
  "## Recommended first experiment",
  "",
  "One-time 129 ₽ pack without autorenew, fixed VC allowance sized against the worst modeled cost per VC, identical in every scenario. Do not auto-enable. Watch first completed chat, registration, D1/D7, confirmed first and repeat payment, cost per activated/paying user, contribution per visitor, support tickets.",
  "",
  "Previous 25.1%/17.6% figures from the older Universe note are **not** guaranteed profit.",
  "",
];
writeFileSync(mdPath, `${lines.join("\n").trimEnd()}\n`);
console.log(`Wrote ${rows.length} rows to docs/universe-acquisition-economy.md`);
console.log(`Recommended experiment: ${payload.recommendation.experiment}`);
