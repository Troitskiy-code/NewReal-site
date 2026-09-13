const DEFAULT_COUNTER_ID = "112171267";

function resolveCounterId() {
  const fromEnv = process.env.NEXT_PUBLIC_YANDEX_METRIKA_ID?.trim();
  if (fromEnv && /^\d+$/.test(fromEnv)) return fromEnv;
  return DEFAULT_COUNTER_ID;
}

export const METRIKA_COUNTER_ID = resolveCounterId();

export const METRIKA_GOALS = {
  subscriptionDialog: "subscription_dialog",
  subscriptionHistory: "subscription_history",
  subscriptionUniverse: "subscription_universe",
  subscriptionSuccess: "subscription_success",
  buyVc: "buy_vc",
  vcPurchaseSuccess: "vc_purchase_success",
  generateAvatar: "generate_avatar",
  createCharacter: "create_character",
  saveCharacter: "save_character",
  sendMessage: "send_message",
  register: "register",
  login: "login",
  characterPageView: "character_page_view",
} as const;

export type MetrikaGoal = (typeof METRIKA_GOALS)[keyof typeof METRIKA_GOALS];

declare global {
  interface Window {
    ym?: (counterId: number, method: string, ...args: unknown[]) => void;
  }
}

export function subscriptionGoal(planId: string): MetrikaGoal | null {
  if (planId === "dialog") return METRIKA_GOALS.subscriptionDialog;
  if (planId === "story" || planId === "history") return METRIKA_GOALS.subscriptionHistory;
  if (planId === "universe") return METRIKA_GOALS.subscriptionUniverse;
  return null;
}

export function reachGoal(goal: string, params?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  if (typeof window.ym !== "function") return;

  if (params) {
    window.ym(Number(METRIKA_COUNTER_ID), "reachGoal", goal, params);
  } else {
    window.ym(Number(METRIKA_COUNTER_ID), "reachGoal", goal);
  }
  console.log("[Goal]", goal, params ?? "");
}
