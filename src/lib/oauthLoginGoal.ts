import { METRIKA_GOALS, dispatchGoal } from "./metrika";
import { subscribeMetrikaReady } from "./metrikaLoader";

const inFlight = new Set<string>();
const completed = new Set<string>();
export function trackOAuthLogin(eventId: string): () => void {
  if (typeof window === "undefined" || !eventId) return () => {};
  let cancelled = false;
  const key = `nv:oauth-login:${eventId}`;
  const dispatch = async () => {
    if (cancelled || inFlight.has(key) || completed.has(key)) return;
    try { if (sessionStorage.getItem(key) === "completed") return; } catch { /* in-memory fallback */ }
    inFlight.add(key);
    try {
      const result = await dispatchGoal(METRIKA_GOALS.login);
      if (result.status === "callback_completed") {
        completed.add(key);
        try { sessionStorage.setItem(key, "completed"); } catch { /* in-memory fallback */ }
      }
    } finally { inFlight.delete(key); }
  };
  const unsubscribe = subscribeMetrikaReady(() => { void dispatch(); });
  return () => { cancelled = true; unsubscribe(); };
}
