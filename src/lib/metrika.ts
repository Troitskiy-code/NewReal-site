import { isMetrikaCounterReady, waitForMetrika } from "./metrikaLoader";

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

export type ReachGoalDispatchStatus =
  | "not_ready"
  | "queued"
  | "dispatched"
  | "callback_completed"
  | "timeout"
  | "unknown";


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

export { waitForMetrika, isMetrikaCounterReady };

/**
 * Fire-and-forget for non-purchase goals. Queue push is allowed so events can flush
 * after late tag.js, but a true return only means the counter is already inited.
 */
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
  const ready = isMetrikaCounterReady();
  console.log("[Goal]", goal, params ?? "", ready ? "dispatched" : "queued");
  return ready;
}

export async function dispatchGoal(
  goal: string,
  params?: Record<string, unknown>,
  timeoutMs = 8000
): Promise<{ status: ReachGoalDispatchStatus; goal: string }> {
  if (typeof window === "undefined" || typeof window.ym !== "function" || !isMetrikaCounterReady()) {
    return { status: "not_ready", goal };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: ReachGoalDispatchStatus) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve({ status, goal });
    };
    const timer = window.setTimeout(() => finish("timeout"), timeoutMs);
    try {
      const payload = params ?? {};
      window.ym(Number(METRIKA_COUNTER_ID), "reachGoal", goal, payload, () => finish("callback_completed"));
    } catch {
      finish("unknown");
    }
  });
}
