import { hasPaymentReturnParams, tokenPagePath } from "./urlPrivacy";

export const ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
export type VisitTouch = { at: number; referrerHost?: string; yclid?: string } & Partial<Record<typeof UTM_KEYS[number], string>>;
export type CheckoutAttribution = { version: 1; firstTouch: VisitTouch; lastNonDirect: VisitTouch | null; counterId?: string; clientId?: string };

function digits(value: unknown, max: number): string | undefined {
  return typeof value === "string" && new RegExp(`^[0-9]{5,${max}}$`).test(value) ? value : undefined;
}
function label(value: unknown): string | undefined {
  // Attribution never accepts URLs, addresses, credentials or arbitrary nested context.
  return typeof value === "string" && value.length <= 120 && /^[\p{L}\p{N} _.,+()\-]+$/u.test(value) ? value : undefined;
}
function touch(raw: unknown, now: number): VisitTouch | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.at !== "number" || !Number.isFinite(value.at) || value.at < now - ATTRIBUTION_TTL_MS || value.at > now + 60_000) return null;
  const result: VisitTouch = { at: value.at };
  for (const key of UTM_KEYS) { const clean = label(value[key]); if (clean) result[key] = clean; }
  const yclid = digits(value.yclid, 30); if (yclid) result.yclid = yclid;
  if (typeof value.referrerHost === "string" && value.referrerHost.length <= 253 && /^[a-z0-9.-]+$/i.test(value.referrerHost)) result.referrerHost = value.referrerHost.toLowerCase();
  return result;
}
export function normalizeCheckoutAttribution(raw: unknown, now = Date.now()): CheckoutAttribution | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return null;
  const firstTouch = touch(value.firstTouch, now); if (!firstTouch) return null;
  const last = touch(value.lastNonDirect, now);
  const lastNonDirect = last && last.at >= firstTouch.at && isNonDirectTouch(last) ? last : null;
  const result: CheckoutAttribution = { version: 1, firstTouch, lastNonDirect };
  const counterId = digits(value.counterId, 12), clientId = digits(value.clientId, 30);
  if (counterId && clientId) { result.counterId = counterId; result.clientId = clientId; }
  return result;
}
export function isNonDirectTouch(value: VisitTouch): boolean {
  return Boolean(value.yclid || value.utm_source || value.utm_medium || value.utm_campaign || value.referrerHost);
}
export function visitTouchFromUrl(raw: string, referrer: string, now = Date.now()): VisitTouch | null {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || hasPaymentReturnParams(url.searchParams) || tokenPagePath(url.pathname)) return null;
    const candidate: Record<string, unknown> = { at: now };
    for (const key of UTM_KEYS) candidate[key] = url.searchParams.get(key);
    candidate.yclid = url.searchParams.get("yclid");
    try {
      const ref = new URL(referrer);
      if (/^https?:$/.test(ref.protocol) && !ref.username && !ref.password && ref.hostname !== url.hostname
        && !/(^|\.)(robokassa\.(ru|com)|accounts\.google\.com|newvers\.ai)$/.test(ref.hostname)) candidate.referrerHost = ref.hostname;
    } catch { /* direct or unavailable referrer */ }
    return touch(candidate, now);
  } catch { return null; }
}
export function updateVisitAttribution(previous: unknown, next: VisitTouch | null, now = Date.now()): CheckoutAttribution | null {
  const current = normalizeCheckoutAttribution(previous, now);
  if (!next) return current;
  if (!current) return { version: 1, firstTouch: next, lastNonDirect: isNonDirectTouch(next) ? next : null };
  return { ...current, lastNonDirect: isNonDirectTouch(next) ? next : current.lastNonDirect };
}
