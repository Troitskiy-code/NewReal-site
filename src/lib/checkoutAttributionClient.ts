"use client";
import { METRIKA_COUNTER_ID } from "./metrika";
import { isMetrikaCounterReady } from "./metrikaLoader";
import { normalizeCheckoutAttribution, updateVisitAttribution, visitTouchFromUrl, type CheckoutAttribution } from "./paymentAttribution";

const KEY = "nv-checkout-attribution:v1";
let owner: string | null | undefined;
let generation = 0;
let memory: CheckoutAttribution | null = null;
let lastLocation = "";
function clear() {
  memory = null;
  // Do not recapture account A's still-visible landing URL for account B.
  lastLocation = typeof window === "undefined" ? "" : window.location.href;
  generation++;
  try { window.sessionStorage.removeItem(KEY); } catch { /* memory fallback */ }
}
export function setAttributionUser(userId: string | null) {
  if (owner && owner !== userId) clear();
  owner = userId;
}
export function captureVisitAttribution() {
  if (typeof window === "undefined") return;
  if (!memory) {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(KEY) ?? "null");
      // Guest attribution may be claimed once; another account cannot inherit it.
      if (!saved?.owner || saved.owner === owner) memory = normalizeCheckoutAttribution(saved?.value);
      else clear();
    } catch { /* inaccessible or malformed storage */ }
  }
  const raw = window.location.href;
  if (raw !== lastLocation) {
    memory = updateVisitAttribution(memory, visitTouchFromUrl(raw, lastLocation ? "" : document.referrer));
    lastLocation = raw;
  }
  persist();
}
function persist() {
  try { if (memory) window.sessionStorage.setItem(KEY, JSON.stringify({ owner: owner ?? null, value: memory })); } catch { /* checkout still works */ }
}
export async function getCheckoutAttribution(): Promise<CheckoutAttribution | null> {
  captureVisitAttribution();
  const startedGeneration = generation, startedOwner = owner;
  if (isMetrikaCounterReady() && typeof window.ym === "function") {
    const clientId = await new Promise<string | null>((resolve) => {
      let complete = false;
      const done = (value: unknown) => {
        if (complete) return; complete = true; window.clearTimeout(timer);
        resolve(typeof value === "string" && /^[0-9]{5,30}$/.test(value) ? value : null);
      };
      const timer = window.setTimeout(() => done(null), 800);
      try { window.ym!(Number(METRIKA_COUNTER_ID), "getClientID", done); } catch { done(null); }
    });
    if (startedGeneration !== generation || startedOwner !== owner) return null;
    if (clientId && memory) { memory = { ...memory, counterId: METRIKA_COUNTER_ID, clientId }; persist(); }
  }
  return normalizeCheckoutAttribution(memory);
}
