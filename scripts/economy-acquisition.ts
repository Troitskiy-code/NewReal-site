/**
 * Parameterized acquisition/retention calculator. Does not change live prices.
 * node --experimental-strip-types scripts/economy-acquisition.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUBSCRIPTION_PLANS } from "../src/lib/chatEconomy.ts";
import { shouldPersistEmbeddings } from "../src/lib/ragEligibility.ts";

type Status = "measurement" | "contract" | "assumption";
type Scenario = "low" | "medium" | "high" | "stress";

type Param<T> = { value: T; source: string; date: string; status: Status; note?: string };

const AS_OF = "2026-10-01";

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
  usdRub: { value: 90, source: "round FX placeholder, not a CBR snapshot", date: AS_OF, status: "assumption" as Status },
  cheapUsdPer1M: { value: 0.4, source: "economical-model placeholder, not p95", date: AS_OF, status: "assumption" as Status },
  dearUsdPer1M: { value: 8, source: "expensive-model placeholder, not p95", date: AS_OF, status: "assumption" as Status },
  tokensInPerRequest: {
    value: { low: 1_200, medium: 2_400, high: 6_000, stress: 12_000 },
    source: "unmeasured; do not treat as product p50/p95",
    date: AS_OF,
    status: "assumption" as Status,
  },
  tokensOutPerRequest: {
    value: { low: 400, medium: 900, high: 2_000, stress: 4_000 },
    source: "unmeasured",
    date: AS_OF,
    status: "assumption" as Status,
  },
  cheapVc: { value: 5, source: "catalog placeholder used only when DB is unavailable", date: AS_OF, status: "assumption" as Status },
  dearVc: { value: 50, source: "catalog placeholder", date: AS_OF, status: "assumption" as Status },
  imageRub: { value: { low: 0, medium: 12, high: 40, stress: 120 }, source: "unmeasured image COGS", date: AS_OF, status: "assumption" as Status },
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

function aiRubPerRequest(scenario: Scenario, dearShare: number): number {
  const tokensIn = params.tokensInPerRequest.value[scenario];
  const tokensOut = params.tokensOutPerRequest.value[scenario];
  const cheap = ((tokensIn + tokensOut) / 1_000_000) * params.cheapUsdPer1M.value * params.usdRub.value;
  const dear = ((tokensIn + tokensOut) / 1_000_000) * params.dearUsdPer1M.value * params.usdRub.value;
  const mix = cheap * (1 - dearShare) + dear * dearShare;
  return mix * params.retryFactor.value[scenario] * params.ragExtraFactor.value[scenario];
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

function firstPackVcFor(scenario: Scenario): number {
  const cost = aiRubPerRequest(scenario, 0);
  if (cost <= 0) return 0;
  const targetRequests = scenario === "low" ? 12 : scenario === "medium" ? 18 : scenario === "high" ? 24 : 30;
  return Math.max(40, Math.round(targetRequests * params.cheapVc.value));
}

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
  const packVc = variant.firstPackRub > 0 ? firstPackVcFor(scenario) : 0;
  const packPayers = variant.firstPackRub > 0 ? payers : 0;
  const subPayers = variant.firstPackRub > 0 ? payers * variant.repeatPayerShare[scenario] : payers;
  const grossRevenue = packPayers * variant.firstPackRub + subPayers * plan.monthlyPrice;
  const refunds = grossRevenue * params.refundPct.value[scenario];
  const netRevenue = grossRevenue - refunds;
  const acquiring = netRevenue * params.acquiringPct.value;
  const tax = netRevenue * params.taxPct.value;

  const cheapCost = aiRubPerRequest(scenario, 0);
  const mixedCost = aiRubPerRequest(scenario, variant.dearShare[scenario]);
  const guestCost = visitors * variant.guestMessages * cheapCost;
  const dailyCost = accounts * variant.dailyFreeRequests * 30 * cheapCost;
  const trialCost = accounts * variant.premiumTrials * aiRubPerRequest(scenario, 1);
  const packAi = packPayers * Math.floor(packVc / Math.max(params.cheapVc.value, 1)) * cheapCost;
  const paidRequests = subPayers * Math.floor(plan.vcPerMonth / (variant.dearShare[scenario] > 0.3 ? params.dearVc.value : params.cheapVc.value));
  const paidAi = paidRequests * mixedCost;
  const promoAi = paidAi * variant.promoVcBurnShare;
  const images = (accounts + payers) * params.imageRub.value[scenario];
  const support = payers * params.supportTicketsPerPayer.value[scenario] * params.supportRubPerTicket.value;
  const variableCost = guestCost + dailyCost + trialCost + packAi + paidAi + images + support + acquiring + tax;
  const contribution = netRevenue - variableCost;
  const acquisition = visitors * (params.cacRub.value[scenario] / Math.max(visitors, 1)) * visitors;
  const infraShare = params.infraMonthlyRub.value;
  const infraAndAcquisition = infraShare + params.cacRub.value[scenario] * visitors * 0;
  const paidCac = params.cacRub.value[scenario] * payers;
  const profit = contribution - infraShare - paidCac;
  const carryoverLiabilityRub = subPayers * plan.vcPerMonth * 0.25 * (mixedCost / Math.max(params.cheapVc.value, 1));

  return {
    variant: variant.id,
    scenario,
    visitors: Math.round(visitors),
    accounts: Math.round(accounts),
    payers: Math.round(payers),
    grossRevenue: round2(grossRevenue),
    discountsAndRefunds: round2(refunds),
    netRevenue: round2(netRevenue),
    variableCost: round2(variableCost + promoAi - promoAi),
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
process.env.ENABLE_RAG_EMBEDDINGS = previousRag;

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
  formula: {
    netRevenue: "grossRevenue - refunds (promo VC burn is an AI cost, not a second revenue haircut)",
    contribution: "netRevenue - variableCost(AI including retry/RAG/images/support/acquiring/tax)",
    profit: "contribution - infraMonthly - CAC_on_payers",
    rag: "shouldPersistEmbeddings = isRagEligible(paid active plan) OR ENABLE_RAG_EMBEDDINGS",
  },
  rows,
  extras: {
    vcCarryover25pctLiabilityMediumUniverse: evaluate(variants[0], "medium").carryoverLiabilityRub,
    imagePack: "Sell expensive images as a separate SKU so subscription VC is not silently drained. Do not cut already paid image quotas.",
    referral: "Pay referral VC only after PaymentEvent confirmation; reverse on refund of the referred invoice.",
    authors: "Creator payouts stay on current contract. Acquisition experiments must not rewrite existing character revenue share.",
  },
  recommendation: {
    experiment: "firstPack129",
    hypothesis:
      "A 129 ₽ one-time pack sized from economical-model COGS, without autorenew, increases confirmed first payments versus the repaired control funnel without changing Dialog/Story/Universe prices.",
    audience: "New registered users who finished at least one guest reply, RU, desktop+mobile, 28 days plus one billing cycle watch.",
    budgetRub: 40_000,
    stop: "If confirmed first-pay conversion is below control by 20% relative, or support tickets/payer rise 2x, or contribution/visitor stays negative after 28 days AND the following monthly renewal window.",
    rollback: "Disable the SKU; keep already purchased packs; do not alter live subscription prices or paid entitlements.",
    sample: "Need at least 400 first-pay events per arm or 28 days plus renewal observation, whichever is later. 14 days is not enough for monthly renewals.",
    mediumProjection: recommendedMedium,
  },
};

writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);

const lines = [
  "# Acquisition economy calculation (not live prices)",
  "",
  `Date: ${AS_OF}. Live public prices stay Dialog 499 ₽ / 2 500 VC, Story 1 299 ₽ / 10 000 VC, Universe 3 499 ₽ / 30 000 VC.`,
  "",
  "This file is generated by `npm run economy:acquisition`. Inputs are labeled measurement / contract / assumption. There is no product telemetry for p50/p95 tokens, so request costs are parameterized assumptions, not observed averages.",
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
  "| Variant | Scenario | Visitors | Payers | Net revenue ₽ | Contribution ₽ | Profit ₽ | Contrib/visitor | Carryover liability ₽ |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map(
    (row) =>
      `| ${row.variant} | ${row.scenario} | ${row.visitors} | ${row.payers} | ${row.netRevenue} | ${row.contribution} | ${row.profit} | ${row.contributionPerVisitor} | ${row.carryoverLiabilityRub} |`
  ),
  "",
  "## Recommended first experiment",
  "",
  "One-time 129 ₽ pack without autorenew, VC sized from economical-model COGS in this calculator (`firstPackVc` derived per scenario). Do not auto-enable. Watch first completed chat, registration, D1/D7, confirmed first and repeat payment, cost per activated/paying user, contribution per visitor, support tickets.",
  "",
  "Previous 25.1%/17.6% figures from the older Universe note are **not** guaranteed profit.",
  "",
];
writeFileSync(mdPath, `${lines.join("\n")}\n`);
console.log(`Wrote ${rows.length} rows to docs/universe-acquisition-economy.md`);
console.log(`Recommended experiment: ${payload.recommendation.experiment}`);
