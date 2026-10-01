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
  vcPurchaseSuccess: "vc_purchase_success",
  generateAvatar: "generate_avatar",
  createCharacter: "create_character",
  saveCharacter: "save_character",
  sendMessage: "send_message",
  register: "register",
  login: "login",
  loginAttempt: "login_attempt",
  characterPageView: "character_page_view",
  guestChatTransferred: "guest_chat_transferred",
  supportSubmit: "support_submit",
} as const;

export type MetrikaGoal = (typeof METRIKA_GOALS)[keyof typeof METRIKA_GOALS];

declare global {
  interface Window {
    ym?: (counterId: number, method: string, ...args: unknown[]) => void;
  }
}

/** Metrika / public plan slug. DB id stays `story`; goals and Success URL use `history`. */
export function metrikaPlanSlug(planId: string): string {
  return planId === "story" ? "history" : planId;
}

export function subscriptionGoal(planId: string): MetrikaGoal | null {
  const slug = metrikaPlanSlug(planId);
  if (slug === "dialog") return METRIKA_GOALS.subscriptionDialog;
  if (slug === "history") return METRIKA_GOALS.subscriptionHistory;
  if (slug === "universe") return METRIKA_GOALS.subscriptionUniverse;
  return null;
}

export type PaymentGoalHit =
  | { kind: "subscription"; plan: string; planGoal: MetrikaGoal | null }
  | { kind: "vc" };

export function resolvePaymentGoalFromSearchParams(
  searchParams: Pick<URLSearchParams, "get">
): PaymentGoalHit | null {
  const read = (key: string) =>
    (searchParams.get(key) || searchParams.get(key.toLowerCase()) || "").trim();

  const payment = searchParams.get("payment");
  const type = searchParams.get("type") || read("Shp_type");
  const rawPlan = searchParams.get("plan") || read("Shp_plan") || "unknown";
  const plan = metrikaPlanSlug(rawPlan);
  const isSubscription =
    type === "subscription" || read("Shp_subscription").toLowerCase() === "true";
  const isVc = type === "vc" || Boolean(read("Shp_vc") && !isSubscription);
  const invId = searchParams.get("InvId") || searchParams.get("invid");
  const isSuccess = payment === "success" || Boolean(invId && (isSubscription || isVc));

  if (!isSuccess || (!isSubscription && !isVc)) return null;
  if (isSubscription) {
    return { kind: "subscription", plan, planGoal: subscriptionGoal(plan) };
  }
  return { kind: "vc" };
}

export function reachGoal(goal: string, params?: Record<string, unknown>): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.ym !== "function") {
    console.log("[Goal] skipped, ym not ready", goal, params ?? "");
    return false;
  }

  if (params) {
    window.ym(Number(METRIKA_COUNTER_ID), "reachGoal", goal, params);
  } else {
    window.ym(Number(METRIKA_COUNTER_ID), "reachGoal", goal);
  }
  console.log("[Goal]", goal, params ?? "");
  return true;
}

export function waitForMetrika(timeoutMs = 8000): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (typeof window.ym === "function") return Promise.resolve(true);

  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (typeof window.ym === "function") {
        window.clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        window.clearInterval(timer);
        resolve(false);
      }
    }, 200);
  });
}
