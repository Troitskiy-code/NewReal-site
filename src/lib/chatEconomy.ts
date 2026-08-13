export type ChatModel = {
  id: string;
  name: string;
  displayName: string;
  pricePer1MInput: number | null;
  pricePer1MOutput: number | null;
  isFreeForSubscribers: boolean;
  isActive: boolean;
};

export function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function calculateCostRubles(
  inputTokens: number,
  outputTokens: number,
  model: Pick<ChatModel, "pricePer1MInput" | "pricePer1MOutput">
): number {
  const inputPrice = model.pricePer1MInput ?? 0;
  const outputPrice = model.pricePer1MOutput ?? 0;
  return (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
}

export function rublesToRealCoins(rubles: number): number {
  if (rubles <= 0) return 0;
  return Math.max(1, Math.ceil(rubles));
}
