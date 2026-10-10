import { normalizeInvId, type PaymentConfirmationStatus } from "./paymentStatus";
import { isPaymentQueryKey } from "./urlPrivacy";
import {
  METRIKA_COUNTER_ID,
  METRIKA_GOALS,
  dispatchGoal,
  metrikaPlanSlug,
  subscriptionGoal,
} from "./metrika";
import { isMetrikaCounterReady, waitForMetrika } from "./metrikaLoader";
import { logPurchaseAnalytics } from "./purchaseAnalyticsLog";

export type GoalRuntimeState =
  | "pending_confirmation"
  | "ready_to_dispatch"
  | "dispatched"
  | "callback_completed"
  | "timeout"
  | "unknown"
  | "skipped";

type GoalSlot = { state: GoalRuntimeState; attempts: number; updatedAt: number };

export type PendingPurchaseRecord = {
  invoiceId: string;
  userId: string | null;
  createdAt: number;
  updatedAt: number;
  pollAttempts: number;
  lastPollAt: number;
  kind: string | null;
  planId: string | null;
  amountRub: number | null;
  orderId?: string | null;
  analyticsExcluded?: boolean;
  confirmed: boolean;
  bannerSession: boolean;
  goals: Record<string, GoalSlot>;
};

export type PaymentStatusPayload = {
  status?: PaymentConfirmationStatus | "idle" | "pending" | "confirmed";
  invId?: string;
  kind?: string | null;
  planId?: string | null;
  amountRub?: number | null;
  orderId?: string | null;
  analyticsExcluded?: boolean;
};

export type PurchaseGoalSpec = {
  goal: string;
  params?: Record<string, unknown>;
};

const STORAGE_PREFIX = "nv-metrika-pending:";
const LOCK_PREFIX = "nv-metrika-lock:";
const BANNER_PREFIX = "nv-metrika-banner:";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING = 8;
const MAX_DISPATCH_ATTEMPTS = 3;
const MAX_POLL_ATTEMPTS = 90;
const GOAL_CALLBACK_TIMEOUT_MS = 8000;
const DEFAULT_LOCK_TTL_MS = 20_000;

let activeUserId: string | null | undefined;
let runGeneration = 0;
let callbackTimeoutMs = GOAL_CALLBACK_TIMEOUT_MS;
let retryDelayMs: number | null = null;
let lockTtlMs = DEFAULT_LOCK_TTL_MS;
let webLocksDisabled = false;
let runtimeOwnerId = createOwnerId();
let bannerInvoiceId: string | null = null;
const listeners = new Set<(record: PendingPurchaseRecord | null) => void>();
const memoryByOwner = new Map<string, PendingPurchaseRecord[]>();
const tabLocks = new Set<string>();

function createOwnerId() {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function memoryOwner() {
  if (activeUserId === null) return "signed-out";
  return activeUserId ?? "anon";
}

function bannerStorageKey() {
  return `${BANNER_PREFIX}${METRIKA_COUNTER_ID}:${memoryOwner()}`;
}

function persistBannerInvoice(invoiceId: string | null): boolean {
  bannerInvoiceId = invoiceId;
  if (typeof window === "undefined") return false;
  try {
    const key = bannerStorageKey();
    if (invoiceId) window.sessionStorage.setItem(key, invoiceId);
    else window.sessionStorage.removeItem(key);
    return true;
  } catch {
    return invoiceId == null;
  }
}

function readSessionBannerId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(bannerStorageKey());
  } catch {
    return null;
  }
}

function clearBanner() {
  persistBannerInvoice(null);
}

export function setPurchaseTrackerUser(userId: string | null) {
  if ((activeUserId && userId && activeUserId !== userId) || (activeUserId && userId === null)) {
    runGeneration += 1;
    clearBanner();
  }
  activeUserId = userId;
  emitBanner();
}

export function currentPurchaseTrackerGeneration() {
  return runGeneration;
}

function storageKey() {
  return `${STORAGE_PREFIX}${METRIKA_COUNTER_ID}:${memoryOwner()}`;
}

function canWriteLocalLocks() {
  if (typeof window === "undefined") return false;
  try {
    const key = `${LOCK_PREFIX}probe`;
    window.localStorage.setItem(key, "1");
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function emptyRecord(invoiceId: string): PendingPurchaseRecord {
  const now = Date.now();
  return {
    invoiceId,
    userId: activeUserId ?? null,
    createdAt: now,
    updatedAt: now,
    pollAttempts: 0,
    lastPollAt: 0,
    kind: null,
    planId: null,
    amountRub: null,
    confirmed: false,
    bannerSession: false,
    goals: {},
  };
}

export function clonePurchaseRecord(record: PendingPurchaseRecord): PendingPurchaseRecord {
  return {
    ...record,
    goals: Object.fromEntries(
      Object.entries(record.goals).map(([goal, slot]) => [goal, { ...slot }])
    ),
  };
}

function mergeGoalSlots(left?: GoalSlot, right?: GoalSlot): GoalSlot | undefined {
  if (!left) return right ? { ...right } : undefined;
  if (!right) return { ...left };
  const attempts = Math.max(left.attempts, right.attempts);
  const updatedAt = Math.max(left.updatedAt, right.updatedAt);
  if (left.state === "callback_completed" || right.state === "callback_completed") {
    return { state: "callback_completed", attempts, updatedAt };
  }
  if (left.state === "skipped" || right.state === "skipped") {
    return { state: "skipped", attempts, updatedAt };
  }
  const newer = left.updatedAt >= right.updatedAt ? left : right;
  return { state: newer.state, attempts, updatedAt: newer.updatedAt };
}

function mergePurchaseRecords(left: PendingPurchaseRecord, right: PendingPurchaseRecord): PendingPurchaseRecord {
  const newer = left.updatedAt >= right.updatedAt ? left : right;
  const older = newer === left ? right : left;
  const goals: Record<string, GoalSlot> = {};
  for (const name of new Set([...Object.keys(left.goals), ...Object.keys(right.goals)])) {
    const merged = mergeGoalSlots(left.goals[name], right.goals[name]);
    if (merged) goals[name] = merged;
  }
  return {
    invoiceId: left.invoiceId,
    userId: newer.userId ?? older.userId,
    createdAt: Math.min(left.createdAt || newer.createdAt, right.createdAt || newer.createdAt),
    updatedAt: Math.max(left.updatedAt, right.updatedAt),
    pollAttempts: Math.max(left.pollAttempts, right.pollAttempts),
    lastPollAt: Math.max(left.lastPollAt, right.lastPollAt),
    kind: newer.kind ?? older.kind,
    planId: newer.planId ?? older.planId,
    amountRub: newer.amountRub ?? older.amountRub,
    orderId: newer.confirmed ? newer.orderId ?? older.orderId ?? null : null,
    analyticsExcluded: newer.analyticsExcluded === true,
    confirmed: newer.confirmed,
    bannerSession: false,
    goals,
  };
}

function mergeRecordLists(...lists: PendingPurchaseRecord[][]) {
  const map = new Map<string, PendingPurchaseRecord>();
  for (const list of lists) {
    for (const item of list) {
      if (!item || typeof item.invoiceId !== "string") continue;
      const prev = map.get(item.invoiceId);
      map.set(item.invoiceId, prev ? mergePurchaseRecords(prev, clonePurchaseRecord(item)) : clonePurchaseRecord(item));
    }
  }
  return [...map.values()];
}

function parseStore(raw: string | null): PendingPurchaseRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as PendingPurchaseRecord[];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter((item) => item && typeof item.invoiceId === "string" && now - item.createdAt < TTL_MS);
  } catch {
    return [];
  }
}

function readStore(store: Storage | undefined) {
  if (!store) return [];
  try {
    return parseStore(store.getItem(storageKey()));
  } catch {
    return [];
  }
}

function writeStore(store: Storage | undefined, payload: string) {
  if (!store) return false;
  try {
    store.setItem(storageKey(), payload);
    return true;
  } catch {
    return false;
  }
}

function getMemory() {
  return memoryByOwner.get(memoryOwner()) ?? [];
}

function setMemory(records: PendingPurchaseRecord[]) {
  memoryByOwner.set(memoryOwner(), records.map(clonePurchaseRecord));
}

function readAll(): PendingPurchaseRecord[] {
  if (typeof window === "undefined") {
    const memory = getMemory();
    return memory.map(clonePurchaseRecord);
  }
  const merged = mergeRecordLists(
    readStore(window.localStorage),
    readStore(window.sessionStorage),
    getMemory()
  );
  setMemory(merged);
  return merged.map(clonePurchaseRecord);
}

function writeAll(records: PendingPurchaseRecord[]): boolean {
  const trimmed = records.slice(-MAX_PENDING).map(clonePurchaseRecord);
  setMemory(trimmed);
  if (typeof window === "undefined") return false;
  const payload = JSON.stringify(trimmed);
  const localOk = writeStore(window.localStorage, payload);
  const sessionOk = writeStore(window.sessionStorage, payload);
  return localOk || sessionOk;
}

function emitBanner() {
  const snapshot = resolveBannerRecord();
  for (const listener of [...listeners]) listener(snapshot);
}

export function subscribePurchaseRecord(listener: (record: PendingPurchaseRecord | null) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function listPendingPurchases() {
  return readAll();
}

function recordBelongsToActiveUser(record: PendingPurchaseRecord) {
  if (activeUserId === null) return false;
  if (record.userId && activeUserId && record.userId !== activeUserId) return false;
  return true;
}

export function upsertPendingPurchase(patch: PendingPurchaseRecord, writeGeneration?: number) {
  if (writeGeneration != null && writeGeneration !== runGeneration) return;
  if (!recordBelongsToActiveUser(patch)) return;
  const next = clonePurchaseRecord({ ...patch, updatedAt: Date.now(), bannerSession: false });
  const records = readAll().filter((item) => item.invoiceId !== next.invoiceId);
  records.push(next);
  writeAll(records);
  emitBanner();
}

export function extractInvoiceIdFromLocation(search = typeof window === "undefined" ? "" : window.location.search) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return normalizeInvId(params.get("InvId") || params.get("invid"));
}

export function stripPaymentQuery(): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (isPaymentQueryKey(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return true;
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  return true;
}

function visibleToCurrentUser(record: PendingPurchaseRecord) {
  if (activeUserId === null) return false;
  if (!record.userId || !activeUserId) return true;
  return record.userId === activeUserId;
}

export function resolveBannerRecord(): PendingPurchaseRecord | null {
  if (activeUserId === null) return null;
  const target = extractInvoiceIdFromLocation() ?? bannerInvoiceId ?? readSessionBannerId();
  if (!target) return null;
  const match = readAll().filter(visibleToCurrentUser).find((item) => item.invoiceId === target) ?? null;
  if (!match) return null;
  if (match.userId && activeUserId && match.userId !== activeUserId) return null;
  return clonePurchaseRecord(match);
}

export function captureInvoiceFromUrl(): PendingPurchaseRecord | null {
  const invoiceId = extractInvoiceIdFromLocation();
  if (!invoiceId) {
    emitBanner();
    return resolveBannerRecord();
  }
  const existing = readAll().find((item) => item.invoiceId === invoiceId);
  let record: PendingPurchaseRecord;
  if (existing?.userId && activeUserId && existing.userId !== activeUserId) {
    record = emptyRecord(invoiceId);
  } else {
    record = existing ? clonePurchaseRecord(existing) : emptyRecord(invoiceId);
    if (!record.userId && activeUserId) record.userId = activeUserId;
  }
  record.bannerSession = false;
  record.updatedAt = Date.now();
  const bannerPersisted = persistBannerInvoice(invoiceId);
  const others = readAll().filter((item) => item.invoiceId !== invoiceId);
  const stored = writeAll([...others, record]);
  logPurchaseAnalytics("return_captured", record);
  if (stored && bannerPersisted) stripPaymentQuery();
  emitBanner();
  return clonePurchaseRecord(record);
}

export function purchaseGoalsFromStatus(data: PaymentStatusPayload): PurchaseGoalSpec[] {
  if (data.kind === "subscription_renewal" || data.analyticsExcluded) return [];
  const order = typeof data.orderId === "string" && /^(po|pe)_[a-zA-Z0-9-]{8,64}$/.test(data.orderId) ? { order_id: data.orderId } : {};
  if (data.kind === "purchase") {
    const params: Record<string, unknown> = { ...order };
    if (typeof data.amountRub === "number" && data.amountRub > 0) {
      params.order_price = data.amountRub;
      params.currency = "RUB";
    }
    return [{ goal: METRIKA_GOALS.vcPurchaseSuccess, params }];
  }
  if (data.kind === "subscription" || data.kind === "subscription_pending") {
    const specs: PurchaseGoalSpec[] = [];
    const params: Record<string, unknown> = { ...order };
    if (data.planId) params.plan = metrikaPlanSlug(data.planId);
    if (typeof data.amountRub === "number" && data.amountRub > 0) {
      params.order_price = data.amountRub;
      params.currency = "RUB";
    }
    specs.push({ goal: METRIKA_GOALS.subscriptionSuccess, params });
    const planGoal = data.planId ? subscriptionGoal(data.planId) : null;
    if (planGoal) {
      specs.push({
        goal: planGoal,
        params: { ...order, plan: metrikaPlanSlug(data.planId!) },
      });
    }
    return specs;
  }
  return [];
}

export function confirmationStatusOf(record: PendingPurchaseRecord | null): PaymentConfirmationStatus {
  if (!record) return "idle";
  if (record.confirmed) return "confirmed";
  if (record.pollAttempts >= 15) return "waiting";
  return "pending";
}

type LockLease = { owner: string; expiresAt: number };

function lockKey(invoiceId: string) {
  return `${LOCK_PREFIX}${METRIKA_COUNTER_ID}:${invoiceId}`;
}

function readLease(key: string): LockLease | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LockLease;
    if (!parsed || typeof parsed.owner !== "string" || typeof parsed.expiresAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLease(key: string, lease: LockLease): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(lease));
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function tryAcquireLock(invoiceId: string, owner: string): Promise<"acquired" | "held" | "unavailable"> {
  const key = lockKey(invoiceId);
  const now = Date.now();
  const current = readLease(key);
  if (current && current.expiresAt > now) return "held";
  if (!writeLease(key, { owner, expiresAt: now + lockTtlMs })) return "unavailable";
  await delay(20);
  const stored = readLease(key);
  if (!stored) return "unavailable";
  return stored.owner === owner ? "acquired" : "held";
}

function renewLock(invoiceId: string, owner: string): boolean {
  const key = lockKey(invoiceId);
  const current = readLease(key);
  if (!current || current.owner !== owner) return false;
  if (!writeLease(key, { owner, expiresAt: Date.now() + lockTtlMs })) return false;
  return readLease(key)?.owner === owner;
}

function releaseLock(invoiceId: string, owner: string) {
  const key = lockKey(invoiceId);
  const current = readLease(key);
  if (current?.owner === owner) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

async function withTabLock<T>(invoiceId: string, work: (renew: () => boolean) => Promise<T>): Promise<T | undefined> {
  if (tabLocks.has(invoiceId)) return undefined;
  tabLocks.add(invoiceId);
  try {
    return await work(() => true);
  } finally {
    tabLocks.delete(invoiceId);
  }
}

async function withInvoiceLock<T>(
  invoiceId: string,
  work: (renew: () => boolean) => Promise<T>
): Promise<T | undefined> {
  const name = lockKey(invoiceId);
  const owner = runtimeOwnerId;
  const locks = webLocksDisabled ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks?.request) {
    return locks.request(name, () => work(() => true));
  }
  if (!canWriteLocalLocks()) {
    return withTabLock(invoiceId, work);
  }
  try {
    const acquired = await tryAcquireLock(invoiceId, owner);
    if (acquired === "held") return undefined;
    if (acquired === "unavailable") {
      return withTabLock(invoiceId, work);
    }
    const startInterval =
      typeof window.setInterval === "function" ? window.setInterval.bind(window) : globalThis.setInterval;
    const stopInterval =
      typeof window.clearInterval === "function" ? window.clearInterval.bind(window) : globalThis.clearInterval;
    const beat = startInterval(() => {
      renewLock(invoiceId, owner);
    }, Math.max(1000, Math.floor(lockTtlMs / 4)));
    try {
      return await work(() => renewLock(invoiceId, owner));
    } finally {
      stopInterval(beat);
      releaseLock(invoiceId, owner);
    }
  } catch {
    releaseLock(invoiceId, owner);
    return withTabLock(invoiceId, work);
  }
}

async function fetchStatus(invoiceId: string, generation: number): Promise<PaymentStatusPayload | { http: number }> {
  const res = await fetch(`/api/payment/status?invId=${encodeURIComponent(invoiceId)}`, {
    credentials: "same-origin",
  });
  if (generation !== runGeneration) return { http: 0 };
  if (res.status === 401) return { http: 401 };
  if (!res.ok) return { http: res.status };
  return (await res.json()) as PaymentStatusPayload;
}

function ensureGoalStates(record: PendingPurchaseRecord, specs: PurchaseGoalSpec[]) {
  for (const spec of specs) {
    if (!record.goals[spec.goal]) {
      record.goals[spec.goal] = { state: "ready_to_dispatch", attempts: 0, updatedAt: Date.now() };
    }
  }
}

async function dispatchPendingGoals(
  record: PendingPurchaseRecord,
  generation: number,
  ownerUserId: string | null | undefined,
  renew: () => boolean
) {
  if (generation !== runGeneration || activeUserId !== ownerUserId || !renew()) return;
  const specs = purchaseGoalsFromStatus(record);
  if (specs.length === 0) return;
  ensureGoalStates(record, specs);
  if (!renew()) return;
  const ready = isMetrikaCounterReady() || (await waitForMetrika(12000));
  if (!ready && generation === runGeneration && activeUserId === ownerUserId) {
    logPurchaseAnalytics("counter_not_ready", record);
  }
  if (!ready || generation !== runGeneration || activeUserId !== ownerUserId || !renew()) return;
  if (record.userId && activeUserId && record.userId !== activeUserId) return;

  for (const spec of specs) {
    if (generation !== runGeneration || activeUserId !== ownerUserId || !renew()) return;
    const slot = record.goals[spec.goal];
    if (!slot) continue;
    if (slot.state === "callback_completed") { reportGoalReceipt(record, spec.goal, slot); continue; }
    if (slot.state === "skipped") continue;
    if (slot.attempts >= MAX_DISPATCH_ATTEMPTS) continue;
    slot.state = "dispatched";
    slot.attempts += 1;
    slot.updatedAt = Date.now();
    upsertPendingPurchase(record, generation);
    if (!renew()) return;
    reportGoalReceipt(record, spec.goal, slot);
    logPurchaseAnalytics("dispatch_started", record, { goal: spec.goal, attempts: slot.attempts });
    const result = await dispatchGoal(spec.goal, spec.params, callbackTimeoutMs);
    logPurchaseAnalytics("dispatch_result", record, { goal: spec.goal, attempts: slot.attempts, state: result.status });
    if (generation !== runGeneration || activeUserId !== ownerUserId || !renew()) return;
    if (result.status === "callback_completed") {
      slot.state = "callback_completed";
    } else if (result.status === "timeout") {
      slot.state = "timeout";
    } else if (result.status === "not_ready") {
      slot.state = "ready_to_dispatch";
      slot.attempts = Math.max(0, slot.attempts - 1);
    } else {
      slot.state = "unknown";
    }
    slot.updatedAt = Date.now();
    upsertPendingPurchase(record, generation);
    reportGoalReceipt(record, spec.goal, slot);
    if (slot.state === "timeout" || slot.state === "unknown") {
      const wait = retryDelayMs ?? Math.min(8000, 2000 * slot.attempts);
      if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait));
      if (!renew()) return;
    }
  }
}

function reportGoalReceipt(record: PendingPurchaseRecord, goal: string, slot: GoalSlot) {
  if (!record.orderId || !record.confirmed || slot.attempts < 1 || !["dispatched", "callback_completed", "timeout", "unknown"].includes(slot.state)) return;
  // Receipt failure never causes a second reachGoal or blocks the payment UI.
  // Snapshot: slot can change while the request is in flight.
  const details = { goal, attempts: slot.attempts, state: slot.state };
  void fetch("/api/payment/analytics", { method: "POST", headers: { "Content-Type": "application/json" },
    credentials: "same-origin", keepalive: true,
    body: JSON.stringify({ invoiceId: record.invoiceId, orderId: record.orderId, goal,
      state: slot.state === "dispatched" ? "attempt_started" : slot.state, attempts: slot.attempts }) })
    .then((response) => logPurchaseAnalytics(response.ok ? "receipt_saved" : "receipt_rejected", record,
      { ...details, status: response.status }))
    .catch(() => logPurchaseAnalytics("receipt_network_error", record, details));
}

export async function pollAndDispatchInvoice(invoiceId: string): Promise<PendingPurchaseRecord | null> {
  if (typeof window === "undefined") return null;
  const generation = runGeneration;
  const ownerUserId = activeUserId;
  return (
    (await withInvoiceLock(invoiceId, async (renew) => {
      if (generation !== runGeneration || activeUserId !== ownerUserId || !renew()) return null;
      let record = readAll().find((item) => item.invoiceId === invoiceId) ?? emptyRecord(invoiceId);

      if (record.userId && activeUserId && record.userId !== activeUserId) {
        return emptyRecord(invoiceId);
      }
      if (activeUserId === null) return record;

      try {
        if (!renew()) return record;
        const payload = await fetchStatus(invoiceId, generation);
        if (generation !== runGeneration || activeUserId !== ownerUserId) {
          return clonePurchaseRecord(record);
        }
        record = clonePurchaseRecord(record);
        record.pollAttempts += 1;
        record.lastPollAt = Date.now();
        record.updatedAt = Date.now();
        if ("http" in payload) {
          if (payload.http === 0) return clonePurchaseRecord(record);
          upsertPendingPurchase(record, generation);
          return clonePurchaseRecord(record);
        }
        if (!renew()) {
          upsertPendingPurchase(record, generation);
          return clonePurchaseRecord(record);
        }
        if (payload.status === "confirmed") {
          const wasConfirmed = record.confirmed;
          record.orderId = typeof payload.orderId === "string" ? payload.orderId : null;
          record.analyticsExcluded = payload.analyticsExcluded === true;
          if (payload.kind === "subscription_renewal") {
            record.confirmed = true;
            record.kind = payload.kind;
            record.planId = payload.planId ?? null;
            record.amountRub = payload.amountRub ?? null;
            record.goals = {};
            if (activeUserId) record.userId = activeUserId;
            upsertPendingPurchase(record, generation);
            return clonePurchaseRecord(record);
          }
          record.confirmed = true;
          record.kind = payload.kind ?? null;
          record.planId = payload.planId ?? null;
          record.amountRub = typeof payload.amountRub === "number" ? payload.amountRub : null;
          if (!wasConfirmed) logPurchaseAnalytics("payment_confirmed", record);
          if (activeUserId) record.userId = activeUserId;
          ensureGoalStates(record, purchaseGoalsFromStatus(record));
          upsertPendingPurchase(record, generation);
          await dispatchPendingGoals(record, generation, ownerUserId, renew);
        } else {
          record.confirmed = false;
          record.kind = null;
          record.planId = null;
          record.amountRub = null;
          record.orderId = null;
          record.analyticsExcluded = false;
          upsertPendingPurchase(record, generation);
        }
      } catch {
        if (generation !== runGeneration || activeUserId !== ownerUserId) {
          return clonePurchaseRecord(record);
        }
        record = clonePurchaseRecord(record);
        record.pollAttempts += 1;
        record.lastPollAt = Date.now();
        record.updatedAt = Date.now();
        upsertPendingPurchase(record, generation);
      }
      return clonePurchaseRecord(readAll().find((item) => item.invoiceId === invoiceId) ?? record);
    })) ?? null
  );
}

export function shouldContinuePolling(record: PendingPurchaseRecord | null) {
  if (!record) return false;
  if (record.confirmed) {
    const specs = purchaseGoalsFromStatus(record);
    if (specs.length === 0) return false;
    return specs.some((spec) => {
      const slot = record.goals[spec.goal];
      if (!slot) return true;
      if (slot.state === "callback_completed" || slot.state === "skipped") return false;
      return slot.attempts < MAX_DISPATCH_ATTEMPTS;
    });
  }
  return record.pollAttempts < MAX_POLL_ATTEMPTS && Date.now() - record.createdAt < TTL_MS;
}

export function setPurchaseGoalRuntimeForTests(options?: {
  callbackTimeoutMs?: number;
  retryDelayMs?: number;
  ownerId?: string;
  lockTtlMs?: number;
  disableWebLocks?: boolean;
}) {
  if (options?.callbackTimeoutMs != null) callbackTimeoutMs = options.callbackTimeoutMs;
  if (options?.retryDelayMs != null) retryDelayMs = options.retryDelayMs;
  if (options?.ownerId) runtimeOwnerId = options.ownerId;
  if (options?.lockTtlMs != null) lockTtlMs = options.lockTtlMs;
  if (options?.disableWebLocks != null) webLocksDisabled = options.disableWebLocks;
}

export function resetPurchaseGoalRuntimeForTests() {
  runGeneration += 1;
  activeUserId = undefined;
  listeners.clear();
  memoryByOwner.clear();
  tabLocks.clear();
  bannerInvoiceId = null;
  callbackTimeoutMs = GOAL_CALLBACK_TIMEOUT_MS;
  retryDelayMs = null;
  lockTtlMs = DEFAULT_LOCK_TTL_MS;
  webLocksDisabled = false;
  runtimeOwnerId = createOwnerId();
  if (typeof window !== "undefined") {
    try {
      const prefixes = [STORAGE_PREFIX, LOCK_PREFIX, BANNER_PREFIX];
      for (const store of [window.localStorage, window.sessionStorage]) {
        const keys: string[] = [];
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          if (key && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key);
        }
        for (const key of keys) store.removeItem(key);
      }
    } catch {
      /* ignore */
    }
  }
}

export const PURCHASE_GOAL_POLICY = {
  ttlMs: TTL_MS,
  maxPending: MAX_PENDING,
  maxDispatchAttempts: MAX_DISPATCH_ATTEMPTS,
  maxPollAttempts: MAX_POLL_ATTEMPTS,
  callbackTimeoutMs: GOAL_CALLBACK_TIMEOUT_MS,
  lockTtlMs: DEFAULT_LOCK_TTL_MS,
  duplicateRisk:
    "A timeout after ym.reachGoal may still deliver; retries of that goal can duplicate. Callback-completed goals are not resent. Cross-tab lease uses localStorage when writable; if localStorage setItem fails, processing continues with an in-tab lock and sessionStorage/memory, without cross-tab exactly-once. This is local dedupe, not a Yandex guarantee.",
};
