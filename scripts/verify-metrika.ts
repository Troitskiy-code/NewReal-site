/**
 * Isolated Metrika purchase/loader regressions. No production counter, network, or DB.
 */
import { METRIKA_COUNTER_ID, METRIKA_GOALS, dispatchGoal, reachGoal } from "@/lib/metrika";
import {
  METRIKA_TAG_FALLBACK,
  METRIKA_TAG_PRIMARY,
  getMetrikaLoadState,
  getMetrikaScriptSource,
  isMetrikaCounterReady,
  resetMetrikaLoaderForTests,
  startMetrikaLoader,
  subscribeMetrikaReady,
  waitForMetrika,
} from "@/lib/metrikaLoader";
import {
  captureInvoiceFromUrl,
  confirmationStatusOf,
  extractInvoiceIdFromLocation,
  listPendingPurchases,
  pollAndDispatchInvoice,
  purchaseGoalsFromStatus,
  resetPurchaseGoalRuntimeForTests,
  resolveBannerRecord,
  setPurchaseGoalRuntimeForTests,
  setPurchaseTrackerUser,
  shouldContinuePolling,
  subscribePurchaseRecord,
  upsertPendingPurchase,
} from "@/lib/purchaseGoalRuntime";
import { visiblePaymentStatus } from "@/lib/paymentStatus";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

type FakeScript = HTMLScriptElement & {
  onload: ((ev?: Event) => void) | null;
  onerror: ((ev?: Event) => void) | null;
};

function installDom(href = "https://newvers.test/ru/pricing?InvId=42&payment=success&type=subscription&plan=dialog&utm=keep#hash") {
  const scripts: FakeScript[] = [];
  const listeners = new Map<string, Set<EventListener>>();
  const history: { href: string } = { href };

  const doc = {
    scripts,
    head: {
      appendChild(node: FakeScript) {
        scripts.push(node);
        return node;
      },
    },
    getElementsByTagName(tag: string) {
      if (tag === "script") return scripts;
      return [];
    },
    createElement(tag: string) {
      if (tag !== "script") return { tagName: tag };
      const el = {
        async: false,
        src: "",
        dataset: {} as Record<string, string>,
        onload: null as FakeScript["onload"],
        onerror: null as FakeScript["onerror"],
        parentNode: {
          insertBefore(node: FakeScript) {
            scripts.push(node);
            return node;
          },
        },
      };
      return el;
    },
  };

  const store = () => {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      key: (index: number) => [...map.keys()][index] ?? null,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    } as Storage;
  };

  const windowLike = {
    document: doc,
    location: {
      get href() {
        return history.href;
      },
      get search() {
        return new URL(history.href).search;
      },
      get pathname() {
        return new URL(history.href).pathname;
      },
      get hash() {
        return new URL(history.href).hash;
      },
    },
    history: {
      replaceState(_s: unknown, _t: string, url: string) {
        const next = new URL(url, "https://newvers.test");
        history.href = next.toString();
      },
    },
    navigator: {},
    addEventListener(type: string, listener: EventListener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    dispatchEvent(event: Event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    localStorage: store(),
    sessionStorage: store(),
    ym: undefined as unknown,
  };

  (globalThis as { window?: typeof windowLike }).window = windowLike;
  (globalThis as { document?: typeof doc }).document = doc;
  return { windowLike, scripts, listeners, history };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function makeReady(scripts: FakeScript[], counterId = "999001") {
  startMetrikaLoader(counterId);
  scripts[0]?.onload?.(new Event("load"));
  window.dispatchEvent(new Event(`yacounter${counterId}inited`));
  assert(isMetrikaCounterReady(), "counter ready after inited event");
}

async function main() {
  console.log("Metrika mapping");
  assert(purchaseGoalsFromStatus({ kind: "purchase", amountRub: 300, status: "confirmed" })[0]?.goal === METRIKA_GOALS.vcPurchaseSuccess, "VC confirmed → one goal");
  const vc = purchaseGoalsFromStatus({ kind: "purchase", amountRub: 300, status: "confirmed" });
  assert(vc[0]?.params?.order_price === 300, "VC revenue on the purchase goal");
  const sub = purchaseGoalsFromStatus({ kind: "subscription", planId: "dialog", amountRub: 499, status: "confirmed" });
  assert(sub.length === 2, "subscription → success + plan goal");
  assert(sub[0]?.goal === METRIKA_GOALS.subscriptionSuccess && sub[0].params?.order_price === 499, "revenue only on success goal");
  assert(sub[1]?.goal === METRIKA_GOALS.subscriptionDialog && sub[1].params?.order_price === undefined, "plan goal has no order_price");
  assert(purchaseGoalsFromStatus({ kind: "subscription", planId: "story", status: "confirmed" })[1]?.goal === METRIKA_GOALS.subscriptionHistory, "DB story → history goal");
  assert(purchaseGoalsFromStatus({ kind: "subscription_pending", planId: "universe", status: "confirmed" })[1]?.goal === METRIKA_GOALS.subscriptionUniverse, "pending purchase still sends universe goal");
  assert(purchaseGoalsFromStatus({ kind: "subscription_renewal", planId: "dialog", status: "confirmed" }).length === 0, "renewal is not a new purchase goal");
  const unknownPlan = purchaseGoalsFromStatus({ kind: "subscription", planId: null, status: "confirmed" });
  assert(unknownPlan.length === 1 && unknownPlan[0]?.goal === METRIKA_GOALS.subscriptionSuccess, "missing plan does not invent a plan goal");
  assert(purchaseGoalsFromStatus({ kind: null, status: "pending" }).length === 0, "unconfirmed payload sends no goals");
  assert(extractInvoiceIdFromLocation("?InvId=ok") === null, "invoiceId=ok is rejected");

  console.log("Loader fallback creates a new script");
  {
    resetMetrikaLoaderForTests();
    const { scripts } = installDom();
    startMetrikaLoader("999001");
    assert(scripts.length === 1 && scripts[0].src === METRIKA_TAG_PRIMARY, "primary script requested");
    assert(getMetrikaLoadState() === "loading", "load state is loading");
    assert(typeof window.ym === "function", "ym queue exists before tag.js");
    assert(!isMetrikaCounterReady(), "ym queue is not counter-ready");
    assert(reachGoal(METRIKA_GOALS.login) === false, "non-purchase reachGoal is not success before init");
    scripts[0].onerror?.(new Event("error"));
    assert(scripts.length === 2 && scripts[1].src === METRIKA_TAG_FALLBACK, "fallback uses a new script element");
    assert(scripts[0].src === METRIKA_TAG_PRIMARY, "primary src is not rewritten");
    const readyPromise = waitForMetrika(200);
    scripts[1].onload?.(new Event("load"));
    window.dispatchEvent(new Event("yacounter999001inited"));
    const ready = await readyPromise;
    assert(ready && isMetrikaCounterReady(), "inited event marks counter ready");
    assert(getMetrikaScriptSource() === "fallback", "source recorded as fallback");
    let late = false;
    subscribeMetrikaReady(() => {
      late = true;
    });
    assert(late, "late subscriber sees ready state");
    const before = scripts.length;
    const inits = ((window.ym as { a?: unknown[] })?.a ?? []).length;
    startMetrikaLoader("999001");
    assert(scripts.length === before, "remount does not insert another tag script");
    assert(isMetrikaCounterReady(), "remount keeps ready state");
    void inits;
  }

  console.log("Both sources fail remain recoverable");
  {
    resetMetrikaLoaderForTests();
    resetPurchaseGoalRuntimeForTests();
    const { scripts, history } = installDom();
    startMetrikaLoader("999001");
    scripts[0].onerror?.(new Event("error"));
    scripts[1].onerror?.(new Event("error"));
    assert(!isMetrikaCounterReady(), "failed load is not ready");
    assert(getMetrikaLoadState() === "failed", "load state failed");
    captureInvoiceFromUrl();
    assert(listPendingPurchases().some((item) => item.invoiceId === "42"), "pending invoice stored");
    assert(!/InvId=/.test(history.href), "payment query stripped only after persist");
  }

  console.log("Invoice capture preserves non-payment query");
  {
    resetPurchaseGoalRuntimeForTests();
    installDom();
    assert(extractInvoiceIdFromLocation() === "42", "InvId from URL");
    captureInvoiceFromUrl();
    const href = window.location.href;
    assert(!/InvId=/.test(href) && !/payment=/.test(href), "payment query stripped after persist");
    assert(/utm=keep/.test(href) && /#hash/.test(href), "utm and hash preserved");
    assert(window.location.pathname.includes("/ru/pricing"), "locale path preserved");
  }

  console.log("Storage failure keeps payment query");
  {
    resetPurchaseGoalRuntimeForTests();
    const { history } = installDom();
    window.localStorage.setItem = () => {
      throw new Error("quota");
    };
    window.sessionStorage.setItem = () => {
      throw new Error("quota");
    };
    captureInvoiceFromUrl();
    assert(/InvId=42/.test(history.href), "query kept when storage cannot persist");
    assert(listPendingPurchases().some((item) => item.invoiceId === "42"), "in-memory pending still exists");
  }

  console.log("Server-confirmed dispatch, independent goals, spoofed query ignored");
  {
    resetMetrikaLoaderForTests();
    resetPurchaseGoalRuntimeForTests();
    setPurchaseGoalRuntimeForTests({ callbackTimeoutMs: 40, retryDelayMs: 0 });
    const { scripts } = installDom("https://newvers.test/en/pricing?InvId=77&type=vc&plan=universe");
    await makeReady(scripts);
    const calls: string[] = [];
    window.ym = ((id: number, method: string, goal: string, _params: unknown, cb?: () => void) => {
      if (method === "reachGoal") {
        calls.push(goal);
        if (goal === METRIKA_GOALS.subscriptionSuccess && typeof cb === "function") cb();
      }
    }) as typeof window.ym;
    setPurchaseTrackerUser("user-1");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      jsonResponse({
        status: "confirmed",
        invId: "77",
        kind: "subscription",
        planId: "dialog",
        amountRub: 499,
      });
    try {
      await pollAndDispatchInvoice("77");
      const record = listPendingPurchases().find((item) => item.invoiceId === "77");
      assert(record?.confirmed === true, "server confirmation stored");
      assert(record?.planId === "dialog", "plan comes from status API, not query");
      assert(calls.includes(METRIKA_GOALS.subscriptionSuccess) && calls.includes(METRIKA_GOALS.subscriptionDialog), "dialog goals from server plan");
      assert(!calls.includes(METRIKA_GOALS.subscriptionUniverse), "query universe is ignored");
      assert(!calls.includes(METRIKA_GOALS.vcPurchaseSuccess), "query type=vc is ignored");
      assert(record?.goals[METRIKA_GOALS.subscriptionSuccess]?.state === "callback_completed", "success goal callback completed");
      assert(record?.goals[METRIKA_GOALS.subscriptionDialog]?.state === "timeout", "missing callback is timeout, not sent");
      const before = calls.filter((goal) => goal === METRIKA_GOALS.subscriptionSuccess).length;
      await pollAndDispatchInvoice("77");
      const afterSuccess = calls.filter((goal) => goal === METRIKA_GOALS.subscriptionSuccess).length;
      const dialogAttempts = calls.filter((goal) => goal === METRIKA_GOALS.subscriptionDialog).length;
      assert(afterSuccess === before, "completed subscription_success is not resent");
      assert(dialogAttempts >= 2, "incomplete plan goal is retried");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("401/5xx/foreign invoice do not dispatch");
  {
    resetMetrikaLoaderForTests();
    resetPurchaseGoalRuntimeForTests();
    const { scripts } = installDom("https://newvers.test/ru/coins?InvId=88");
    await makeReady(scripts);
    const calls: string[] = [];
    window.ym = ((id: number, method: string, goal: string) => {
      if (method === "reachGoal") calls.push(goal);
    }) as typeof window.ym;
    setPurchaseTrackerUser("user-1");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => jsonResponse({ error: "unauthorized" }, 401);
      await pollAndDispatchInvoice("88");
      assert(calls.length === 0, "401 does not dispatch");
      globalThis.fetch = async () => jsonResponse({ error: "down" }, 500);
      await pollAndDispatchInvoice("88");
      assert(calls.length === 0, "5xx does not dispatch");
      globalThis.fetch = async () => jsonResponse({ status: "pending", invId: "88" });
      await pollAndDispatchInvoice("88");
      assert(calls.length === 0, "foreign/pending status does not dispatch");
      assert(listPendingPurchases().find((item) => item.invoiceId === "88")?.confirmed !== true, "pending is not marked sent");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("Logout cancels in-flight confirmation");
  {
    resetMetrikaLoaderForTests();
    resetPurchaseGoalRuntimeForTests();
    const { scripts } = installDom();
    await makeReady(scripts);
    const calls: string[] = [];
    window.ym = ((id: number, method: string, goal: string, _p: unknown, cb?: () => void) => {
      if (method === "reachGoal") {
        calls.push(goal);
        if (typeof cb === "function") cb();
      }
    }) as typeof window.ym;
    setPurchaseTrackerUser("user-a");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(
            jsonResponse({
              status: "confirmed",
              invId: "42",
              kind: "purchase",
              amountRub: 300,
            })
          );
        }, 30);
      });
    try {
      const pending = pollAndDispatchInvoice("42");
      setPurchaseTrackerUser(null);
      await pending;
      assert(calls.length === 0, "logout drops stale confirmed payload");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("dispatchGoal requires counter readiness");
  {
    resetMetrikaLoaderForTests();
    installDom();
    startMetrikaLoader("999001");
    const queued = await dispatchGoal(METRIKA_GOALS.sendMessage);
    assert(queued.status === "not_ready", "queue push is not a completed dispatch");
  }

  console.log("Banner switches to a new invoice and ignores leftover confirmed rows");
  {
    resetPurchaseGoalRuntimeForTests();
    installDom("https://newvers.test/ru/coins");
    setPurchaseTrackerUser("user-A");
    upsertPendingPurchase({
      invoiceId: "203",
      userId: "user-A",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
      pollAttempts: 3,
      lastPollAt: Date.now() - 1000,
      kind: "purchase",
      planId: null,
      amountRub: 129,
      confirmed: true,
      bannerSession: false,
      goals: { [METRIKA_GOALS.vcPurchaseSuccess]: { state: "callback_completed", attempts: 1, updatedAt: Date.now() } },
    });
    let seen: { invoiceId?: string; confirmed?: boolean } | null = null;
    const unsub = subscribePurchaseRecord((next) => {
      seen = next;
    });
    window.history.replaceState({}, "", "https://newvers.test/ru/coins?InvId=204");
    captureInvoiceFromUrl();
    unsub();
    const banner = resolveBannerRecord();
    assert(seen?.invoiceId === "204" && seen?.confirmed === false, "hook subscriber receives the new pending invoice");
    assert(banner?.invoiceId === "204", "banner follows the new return invoice");
    assert(banner?.confirmed === false, "new invoice is pending until server confirms");
    assert(confirmationStatusOf(banner) === "pending", "banner is not the previous confirmed purchase");
  }

  console.log("Saved confirmation is not transferred to another account");
  {
    resetMetrikaLoaderForTests();
    resetPurchaseGoalRuntimeForTests();
    const { scripts } = installDom("https://newvers.test/ru/coins?InvId=202");
    await makeReady(scripts);
    setPurchaseTrackerUser("user-A");
    upsertPendingPurchase({
      invoiceId: "202",
      userId: "user-A",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pollAttempts: 1,
      lastPollAt: Date.now(),
      kind: "purchase",
      planId: null,
      amountRub: 129,
      confirmed: true,
      bannerSession: true,
      goals: { [METRIKA_GOALS.vcPurchaseSuccess]: { state: "callback_completed", attempts: 1, updatedAt: Date.now() } },
    });
    setPurchaseTrackerUser("user-B");
    const captured = captureInvoiceFromUrl();
    assert(captured?.userId === "user-B", "B stores its own pending row");
    assert(captured?.confirmed === false, "B does not inherit A's confirmed flag");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({ status: "pending", invId: "202" });
    try {
      const rebound = await pollAndDispatchInvoice("202");
      assert(rebound?.confirmed === false, "server pending wins over stale local confirmation");
      assert(confirmationStatusOf(rebound) === "pending", "banner/status for B is pending");
      assert(listPendingPurchases().every((item) => item.userId !== "user-A"), "A's records are isolated from B");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("Partial storage failure does not resend a completed goal");
  {
    resetMetrikaLoaderForTests();
    resetPurchaseGoalRuntimeForTests();
    setPurchaseGoalRuntimeForTests({ callbackTimeoutMs: 40, retryDelayMs: 0, disableWebLocks: true });
    const { scripts } = installDom("https://newvers.test/ru/coins?InvId=201");
    await makeReady(scripts);
    setPurchaseTrackerUser("user-A");
    upsertPendingPurchase({
      invoiceId: "201",
      userId: "user-A",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pollAttempts: 0,
      lastPollAt: 0,
      kind: null,
      planId: null,
      amountRub: null,
      confirmed: false,
      bannerSession: true,
      goals: {},
    });
    const originalLocalSet = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = (key: string, value: string) => {
      if (key.includes("nv-metrika-pending:")) throw new Error("QuotaExceededError");
      return originalLocalSet(key, value);
    };
    const calls: string[] = [];
    window.ym = ((id: number, method: string, goal: string, _p: unknown, cb?: () => void) => {
      if (method === "reachGoal") {
        calls.push(goal);
        if (typeof cb === "function") cb();
      }
    }) as typeof window.ym;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      jsonResponse({ status: "confirmed", invId: "201", kind: "purchase", amountRub: 129 });
    try {
      await pollAndDispatchInvoice("201");
      await pollAndDispatchInvoice("201");
      assert(calls.filter((goal) => goal === METRIKA_GOALS.vcPurchaseSuccess).length === 1, "completed VC goal is not resent after quota on localStorage");
      const state = listPendingPurchases()[0]?.goals[METRIKA_GOALS.vcPurchaseSuccess]?.state;
      assert(state === "callback_completed", "merged storage keeps callback_completed");
    } finally {
      globalThis.fetch = originalFetch;
      window.localStorage.setItem = originalLocalSet;
    }
  }

  console.log("Storage lease is renewed and checked before a second tab can send");
  {
    resetMetrikaLoaderForTests();
    resetPurchaseGoalRuntimeForTests();
    setPurchaseGoalRuntimeForTests({
      callbackTimeoutMs: 8000,
      retryDelayMs: 0,
      disableWebLocks: true,
      ownerId: "tab-1",
      lockTtlMs: 15000,
    });
    const { scripts } = installDom("https://newvers.test/ru/coins?InvId=205");
    await makeReady(scripts);
    setPurchaseTrackerUser("user-A");
    const owners: string[] = [];
    let pendingCb: (() => void) | undefined;
    window.ym = ((id: number, method: string, _goal: string, _p: unknown, cb?: () => void) => {
      if (method === "reachGoal") {
        owners.push("active");
        pendingCb = cb;
      }
    }) as typeof window.ym;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      jsonResponse({ status: "confirmed", invId: "205", kind: "purchase", amountRub: 129 });
    try {
      const first = pollAndDispatchInvoice("205");
      const waitStart = Date.now();
      while (owners.length === 0 && Date.now() - waitStart < 500) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      setPurchaseGoalRuntimeForTests({ ownerId: "tab-2" });
      const second = await pollAndDispatchInvoice("205");
      assert(second === null, "second tab does not start work while lease is held");
      assert(owners.length === 1, "only the lock owner dispatched");
      pendingCb?.();
      await first;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("Polling continues after 24s and resumes when the network returns");
  {
    resetMetrikaLoaderForTests();
    resetPurchaseGoalRuntimeForTests();
    const { scripts } = installDom("https://newvers.test/ru/coins?InvId=206");
    setPurchaseTrackerUser("user-A");
    const aging = {
      invoiceId: "206",
      userId: "user-A",
      createdAt: Date.now() - 26_000,
      updatedAt: Date.now() - 26_000,
      pollAttempts: 13,
      lastPollAt: Date.now() - 2000,
      kind: null,
      planId: null,
      amountRub: null,
      confirmed: false,
      bannerSession: true,
      goals: {},
    };
    upsertPendingPurchase(aging);
    assert(shouldContinuePolling(aging), "pending invoice still polls after 24s");
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetches += 1;
      if (fetches === 1) throw new Error("offline");
      return jsonResponse({ status: "confirmed", invId: "206", kind: "purchase", amountRub: 129 });
    };
    try {
      const offline = await pollAndDispatchInvoice("206");
      assert(offline?.confirmed !== true, "offline poll is not confirmed");
      await makeReady(scripts);
      window.ym = ((id: number, method: string, _g: string, _p: unknown, cb?: () => void) => {
        if (method === "reachGoal" && typeof cb === "function") cb();
      }) as typeof window.ym;
      const online = await pollAndDispatchInvoice("206");
      assert(online?.confirmed === true, "confirmation resumes after network returns");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("Status payload is owner-scoped");
  {
    const event = { userId: "user-A", kind: "purchase", planId: null, amountRub: 300 };
    assert(visiblePaymentStatus(event, "user-A", "9").status === "confirmed", "owner sees confirmed analytics");
    assert(visiblePaymentStatus(event, "user-B", "9").status === "pending", "other user sees pending without kind");
    assert(visiblePaymentStatus(event, "user-B", "9").kind === undefined, "other user does not receive kind");
    assert(visiblePaymentStatus(null, "user-A", "9").status === "pending", "missing event is pending");
  }

  console.log("Full localStorage failure still processes via sessionStorage without Web Locks");
  {
    resetMetrikaLoaderForTests();
    resetPurchaseGoalRuntimeForTests();
    setPurchaseGoalRuntimeForTests({ callbackTimeoutMs: 40, retryDelayMs: 0, disableWebLocks: true });
    const { scripts } = installDom("https://newvers.test/ru/coins?InvId=301");
    await makeReady(scripts);
    setPurchaseTrackerUser("user-A");
    window.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const calls: string[] = [];
    window.ym = ((id: number, method: string, goal: string, _p: unknown, cb?: () => void) => {
      if (method === "reachGoal") {
        calls.push(goal);
        if (typeof cb === "function") cb();
      }
    }) as typeof window.ym;
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetches += 1;
      return jsonResponse({ status: "confirmed", invId: "301", kind: "purchase", amountRub: 129 });
    };
    try {
      const captured = captureInvoiceFromUrl();
      assert(captured?.invoiceId === "301", "capture keeps the invoice in session/memory");
      const polled = await pollAndDispatchInvoice("301");
      assert(fetches === 1, "status API is called when localStorage locks cannot be written");
      assert(polled?.confirmed === true, "poll confirms without a durable lease");
      assert(calls.filter((goal) => goal === METRIKA_GOALS.vcPurchaseSuccess).length === 1, "goal is sent with sessionStorage only");
      await pollAndDispatchInvoice("301");
      assert(calls.filter((goal) => goal === METRIKA_GOALS.vcPurchaseSuccess).length === 1, "completed goal is not resent on the tab lock path");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("Per-goal merge preserves retry budget after a stale dispatched snapshot");
  {
    resetMetrikaLoaderForTests();
    resetPurchaseGoalRuntimeForTests();
    setPurchaseGoalRuntimeForTests({ callbackTimeoutMs: 40, retryDelayMs: 0, disableWebLocks: true });
    const { scripts } = installDom("https://newvers.test/ru/coins");
    await makeReady(scripts);
    setPurchaseTrackerUser("user-A");
    const now = Date.now();
    const key = `nv-metrika-pending:${METRIKA_COUNTER_ID}:user-A`;
    window.localStorage.setItem(
      key,
      JSON.stringify([
        {
          invoiceId: "302",
          userId: "user-A",
          createdAt: now,
          updatedAt: now,
          pollAttempts: 1,
          lastPollAt: now,
          kind: "purchase",
          planId: null,
          amountRub: 129,
          confirmed: true,
          bannerSession: false,
          goals: { [METRIKA_GOALS.vcPurchaseSuccess]: { state: "dispatched", attempts: 1, updatedAt: now } },
        },
      ])
    );
    window.sessionStorage.setItem(
      key,
      JSON.stringify([
        {
          invoiceId: "302",
          userId: "user-A",
          createdAt: now,
          updatedAt: now + 1,
          pollAttempts: 2,
          lastPollAt: now + 1,
          kind: "purchase",
          planId: null,
          amountRub: 129,
          confirmed: true,
          bannerSession: false,
          goals: { [METRIKA_GOALS.vcPurchaseSuccess]: { state: "timeout", attempts: 2, updatedAt: now + 1 } },
        },
      ])
    );
    const originalLocalSet = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = (storageKey: string, value: string) => {
      if (storageKey.includes("nv-metrika-pending:")) throw new Error("QuotaExceededError");
      return originalLocalSet(storageKey, value);
    };
    const calls: string[] = [];
    window.ym = ((id: number, method: string, goal: string) => {
      if (method === "reachGoal") calls.push(goal);
    }) as typeof window.ym;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      jsonResponse({ status: "confirmed", invId: "302", kind: "purchase", amountRub: 129 });
    try {
      for (let i = 0; i < 5; i += 1) await pollAndDispatchInvoice("302");
      assert(calls.filter((goal) => goal === METRIKA_GOALS.vcPurchaseSuccess).length === 1, "stale dispatched snapshot does not bypass maxDispatchAttempts");
      const attempts = listPendingPurchases()[0]?.goals[METRIKA_GOALS.vcPurchaseSuccess]?.attempts;
      assert(attempts === 3, "merged attempts stop at the dispatch cap");
      assert(!shouldContinuePolling(listPendingPurchases()[0] ?? null), "polling stops after the retry budget is spent");
    } finally {
      globalThis.fetch = originalFetch;
      window.localStorage.setItem = originalLocalSet;
    }
  }

  console.log("Stale poll does not persist into a newly signed-in account");
  {
    resetMetrikaLoaderForTests();
    resetPurchaseGoalRuntimeForTests();
    setPurchaseGoalRuntimeForTests({ callbackTimeoutMs: 40, retryDelayMs: 0, disableWebLocks: true });
    installDom("https://newvers.test/ru/coins");
    setPurchaseTrackerUser("user-A");
    let releaseFetch: ((value: Response) => void) | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        releaseFetch = resolve;
      });
    try {
      const pending = pollAndDispatchInvoice("303");
      setPurchaseTrackerUser(null);
      setPurchaseTrackerUser("user-B");
      releaseFetch?.(jsonResponse({ status: "confirmed", invId: "303", kind: "purchase", amountRub: 129 }));
      await pending;
      assert(
        !listPendingPurchases().some((item) => item.invoiceId === "303"),
        "B's queue does not receive A's in-flight invoice"
      );
      assert(window.localStorage.getItem(`nv-metrika-pending:${METRIKA_COUNTER_ID}:user-B`) == null, "B's durable key is not written by A's poll");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("Banner is session-scoped and does not resurrect in a new tab");
  {
    resetPurchaseGoalRuntimeForTests();
    installDom("https://newvers.test/ru/coins?InvId=304");
    setPurchaseTrackerUser("user-A");
    captureInvoiceFromUrl();
    upsertPendingPurchase({
      invoiceId: "304",
      userId: "user-A",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pollAttempts: 1,
      lastPollAt: Date.now(),
      kind: "purchase",
      planId: null,
      amountRub: 129,
      confirmed: true,
      bannerSession: true,
      goals: { [METRIKA_GOALS.vcPurchaseSuccess]: { state: "callback_completed", attempts: 1, updatedAt: Date.now() } },
    });
    const durable = window.localStorage.getItem(`nv-metrika-pending:${METRIKA_COUNTER_ID}:user-A`);
    const sameTabBanner = window.sessionStorage.getItem(`nv-metrika-banner:${METRIKA_COUNTER_ID}:user-A`);
    assert(resolveBannerRecord()?.invoiceId === "304", "reload in the same tab restores the return banner");
    assert(Boolean(sameTabBanner), "banner invoice is stored in sessionStorage");
    setPurchaseTrackerUser(null);
    setPurchaseTrackerUser("user-A");
    window.history.replaceState({}, "", "https://newvers.test/ru/coins");
    assert(resolveBannerRecord() == null, "A → logout → A without query does not restore the old banner");
    const pendingKey = `nv-metrika-pending:${METRIKA_COUNTER_ID}:user-A`;
    window.sessionStorage.removeItem(`nv-metrika-banner:${METRIKA_COUNTER_ID}:user-A`);
    window.sessionStorage.removeItem(pendingKey);
    if (durable) window.localStorage.setItem(pendingKey, durable);
    assert(resolveBannerRecord() == null, "a new tab without InvId does not show a durable confirmed purchase");
  }

  console.log("");
  if (failed > 0) {
    console.error(`Failed ${failed} of ${passed + failed}`);
    process.exit(1);
  }
  console.log(`Passed ${passed} checks`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
