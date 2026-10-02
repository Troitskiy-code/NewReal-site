export type CostUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reportedCost: number | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
export function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function tokenCount(value: unknown): number | null {
  const n = finiteNonnegative(value);
  return n !== null && Number.isSafeInteger(n) && n <= 2_147_483_647 ? n : null;
}
export function readCostUsage(data: unknown, embedding = false): CostUsage {
  const u = record(record(data).usage);
  return {
    inputTokens: tokenCount(u.prompt_tokens ?? u.input_tokens ?? (embedding ? u.total_tokens : undefined)),
    outputTokens: embedding ? 0 : tokenCount(u.completion_tokens ?? u.output_tokens),
    cachedInputTokens: tokenCount(record(u.prompt_tokens_details).cached_tokens),
    reportedCost: finiteNonnegative(u.cost),
  };
}
export function tokenCostRub(input: number | null, output: number | null,
  inputRate: number | null, outputRate: number | null): number | null {
  if (input === null || output === null || inputRate === null || (output > 0 && outputRate === null)) return null;
  return (input * inputRate + output * (outputRate ?? 0)) / 1_000_000;
}

export type CostedModel = { requestShare: number; vc: number; inputRubPerMillion: number;
  outputRubPerMillion: number; inputTokens: number; outputTokens: number };
export function weightedRequestEconomy(models: CostedModel[]) {
  if (!models.length) throw new Error("Model mix is empty");
  let shares = 0, vc = 0, rub = 0;
  for (const model of models) {
    for (const n of Object.values(model)) {
      if (!Number.isFinite(n) || n < 0) throw new Error("Invalid model mix");
    }
    if (model.requestShare > 0 && model.vc === 0) throw new Error("Free calls must be budgeted separately");
    shares += model.requestShare;
    vc += model.requestShare * model.vc;
    rub += model.requestShare * (model.inputTokens * model.inputRubPerMillion + model.outputTokens * model.outputRubPerMillion) / 1_000_000;
  }
  if (Math.abs(shares - 1) > 1e-8) throw new Error("Model shares must sum to one");
  return { averageVc: vc, averageRub: rub, rubPerVc: rub / vc };
}
