export function estimateRequestCount(vcBudget: number, costVC: number): number {
  if (!Number.isFinite(vcBudget) || !Number.isFinite(costVC) || costVC <= 0 || vcBudget <= 0) {
    return 0;
  }
  return Math.floor(vcBudget / costVC);
}

export type PricedModel = {
  id: string;
  displayName: string;
  priceVC: number;
  isActive: boolean;
};

export function selectEstimateModels(models: PricedModel[]) {
  const active = models.filter((model) => model.isActive && model.priceVC > 0);
  if (active.length === 0) return null;
  const sorted = [...active].sort((a, b) => a.priceVC - b.priceVC);
  return {
    base: sorted[0],
    premium: sorted[sorted.length - 1],
  };
}

export function estimatePlanRequestsFromModels(vcPerMonth: number, models: PricedModel[]) {
  const selected = selectEstimateModels(models);
  if (!selected) {
    return {
      available: false as const,
      baseModel: 0,
      premiumModel: 0,
      baseCostVC: 0,
      premiumCostVC: 0,
      baseName: "",
      premiumName: "",
    };
  }
  return {
    available: true as const,
    baseModel: estimateRequestCount(vcPerMonth, selected.base.priceVC),
    premiumModel: estimateRequestCount(vcPerMonth, selected.premium.priceVC),
    baseCostVC: selected.base.priceVC,
    premiumCostVC: selected.premium.priceVC,
    baseName: selected.base.displayName,
    premiumName: selected.premium.displayName,
  };
}
