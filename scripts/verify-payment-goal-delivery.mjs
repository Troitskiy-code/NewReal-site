/**
 * Diagnostic client-delivery scenarios. Synthetic counter 999001, no production DB or network.
 */
import { METRIKA_GOALS } from "@/lib/metrika";
import { resetMetrikaLoaderForTests, startMetrikaLoader } from "@/lib/metrikaLoader";
import {
  captureInvoiceFromUrl,
  listPendingPurchases,
  pollAndDispatchInvoice,
  resetPurchaseGoalRuntimeForTests,
  setPurchaseGoalRuntimeForTests,
  setPurchaseTrackerUser,
} from "@/lib/purchaseGoalRuntime";

const results = [];
function record(name, detail) {
  results.push({ name, ...detail });
  console.log(JSON.stringify({ name, ...detail }));
}

function installDom(href) {
  const scripts = [];
  const history = { href };
  const store = () => {
    const map = new Map();
    return {
      get length() { return map.size; },
      key: (index) => [...map.keys()][index] ?? null,
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => { map.set(key, value); },
      removeItem: (key) => { map.delete(key); },
    };
  };
  const local = store();
  const session = store();
  const listeners = new Map();
  const doc = {
    referrer: "",
    scripts,
    head: { appendChild(node) { scripts.push(node); return node; } },
    getElementsByTagName(tag) { return tag === "script" ? scripts : []; },
    createElement() {
      return {
        async: false, src: "", dataset: {}, onload: null, onerror: null,
        parentNode: { insertBefore(node) { scripts.push(node); return node; } },
      };
    },
  };
  const windowLike = {
    document: doc,
    location: {
      get href() { return history.href; },
      get search() { return new URL(history.href).search; },
      get pathname() { return new URL(history.href).pathname; },
      get hash() { return new URL(history.href).hash; },
    },
    history: { replaceState(_s, _t, url) { history.href = new URL(url, "https://newvers.test").toString(); } },
    navigator: {},
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    localStorage: local,
    sessionStorage: session,
    ym: undefined,
  };
  globalThis.window = windowLike;
  globalThis.document = doc;
  return { scripts, history, local, session };
}

async function ready(scripts) {
  startMetrikaLoader("999001");
  scripts[0]?.onload?.(new Event("load"));
  window.dispatchEvent(new Event("yacounter999001inited"));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness({ status = "confirmed", analyticsStatus = 200, analyticsThrow = false, orderId = "po_syntheticorder01" } = {}) {
  const goals = [];
  const receipts = [];
  window.ym = ((id, method, goal, _params, cb) => {
    if (method === "reachGoal") {
      goals.push(goal);
      if (typeof cb === "function") cb();
    }
  });
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("/api/payment/analytics")) {
      if (analyticsThrow) throw new Error("network");
      receipts.push({ status: analyticsStatus, body: JSON.parse(init.body) });
      return new Response("{}", { status: analyticsStatus });
    }
    return new Response(JSON.stringify({
      status, invId: "1214420054", kind: "purchase", amountRub: 300, orderId,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { goals, receipts };
}

async function scenario(name, run) {
  resetMetrikaLoaderForTests();
  resetPurchaseGoalRuntimeForTests();
  setPurchaseGoalRuntimeForTests({ callbackTimeoutMs: 30, retryDelayMs: 0, disableWebLocks: true });
  const detail = await run();
  record(name, detail);
}

await scenario("return before webhook, then confirmation", async () => {
  const { scripts } = installDom("https://newvers.test/ru/coins?payment=success&type=vc&InvId=1214420054");
  await ready(scripts);
  setPurchaseTrackerUser("buyer");
  const box = harness({ status: "pending" });
  captureInvoiceFromUrl();
  const early = await pollAndDispatchInvoice("1214420054");
  const before = { goals: box.goals.length, receipts: box.receipts.length, confirmed: early?.confirmed === true };
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("/api/payment/analytics")) {
      box.receipts.push({ status: 200, body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({
      status: "confirmed", invId: "1214420054", kind: "purchase", amountRub: 300, orderId: "po_syntheticorder01",
    }), { status: 200 });
  };
  const late = await pollAndDispatchInvoice("1214420054");
  return { before, goals: box.goals.length, receiptStates: box.receipts.map((item) => item.body.state), confirmed: late?.confirmed === true };
});

await scenario("restored completed queue does not send the goal again", async () => {
  const { scripts } = installDom("https://newvers.test/ru/coins?InvId=1214420054");
  await ready(scripts);
  setPurchaseTrackerUser("buyer");
  const box = harness();
  captureInvoiceFromUrl();
  await pollAndDispatchInvoice("1214420054");
  const saved = listPendingPurchases().find((item) => item.invoiceId === "1214420054");
  resetPurchaseGoalRuntimeForTests();
  setPurchaseGoalRuntimeForTests({ callbackTimeoutMs: 30, retryDelayMs: 0, disableWebLocks: true });
  const { scripts: nextScripts } = installDom("https://newvers.test/ru/coins");
  await ready(nextScripts);
  setPurchaseTrackerUser("buyer");
  if (saved) {
    const { upsertPendingPurchase } = await import("@/lib/purchaseGoalRuntime");
    upsertPendingPurchase(saved);
  }
  const box2 = harness();
  await pollAndDispatchInvoice("1214420054");
  return {
    firstGoals: box.goals.length,
    restoredState: saved?.goals?.[METRIKA_GOALS.vcPurchaseSuccess]?.state ?? null,
    secondGoals: box2.goals.length,
    secondReceipts: box2.receipts.map((item) => item.body.state),
  };
});

await scenario("leaving before confirmation sends nothing", async () => {
  installDom("https://newvers.test/ru/coins?InvId=1214420054");
  setPurchaseTrackerUser("buyer");
  const box = harness({ status: "pending" });
  captureInvoiceFromUrl();
  return { queued: listPendingPurchases().some((item) => item.invoiceId === "1214420054"), goals: box.goals.length, receipts: box.receipts.length };
});

await scenario("no return never starts the queue", async () => {
  installDom("https://newvers.test/ru/coins");
  setPurchaseTrackerUser("buyer");
  const box = harness();
  captureInvoiceFromUrl();
  return { queued: listPendingPurchases().length, goals: box.goals.length, receipts: box.receipts.length };
});

await scenario("counter unavailable confirms payment but does not send", async () => {
  installDom("https://newvers.test/ru/coins?InvId=1214420054");
  setPurchaseTrackerUser("buyer");
  const box = harness();
  captureInvoiceFromUrl();
  const started = Date.now();
  const record = await pollAndDispatchInvoice("1214420054");
  return { ms: Date.now() - started, confirmed: record?.confirmed === true, goals: box.goals.length, receipts: box.receipts.length };
});

for (const analyticsStatus of [403, 401, 400, 500]) {
  await scenario(`analytics HTTP ${analyticsStatus} does not block the goal`, async () => {
    const { scripts } = installDom("https://newvers.test/ru/coins?InvId=1214420054");
    await ready(scripts);
    setPurchaseTrackerUser("buyer");
    const box = harness({ analyticsStatus });
    captureInvoiceFromUrl();
    await pollAndDispatchInvoice("1214420054");
    return { goals: box.goals.length, receiptHttp: box.receipts.map((item) => item.status), states: box.receipts.map((item) => item.body.state) };
  });
}

await scenario("analytics network failure still sends the goal once", async () => {
  const { scripts } = installDom("https://newvers.test/ru/coins?InvId=1214420054");
  await ready(scripts);
  setPurchaseTrackerUser("buyer");
  const box = harness({ analyticsThrow: true });
  captureInvoiceFromUrl();
  const record = await pollAndDispatchInvoice("1214420054");
  return { goals: box.goals.length, receipts: box.receipts.length, state: record?.goals?.[METRIKA_GOALS.vcPurchaseSuccess]?.state ?? null };
});

await scenario("completed goal is reported again without a second reachGoal", async () => {
  const { scripts } = installDom("https://newvers.test/ru/coins?InvId=1214420054");
  await ready(scripts);
  setPurchaseTrackerUser("buyer");
  const box = harness();
  captureInvoiceFromUrl();
  await pollAndDispatchInvoice("1214420054");
  const firstGoals = box.goals.length;
  await pollAndDispatchInvoice("1214420054");
  return { goals: box.goals.length, firstGoals, extraGoals: box.goals.length - firstGoals, states: box.receipts.map((item) => item.body.state) };
});

await scenario("signed-out poll waits, later sign-in sends once", async () => {
  const { scripts } = installDom("https://newvers.test/ru/coins?InvId=1214420054");
  await ready(scripts);
  setPurchaseTrackerUser(null);
  const box = harness();
  captureInvoiceFromUrl();
  const signedOut = await pollAndDispatchInvoice("1214420054");
  const mid = { confirmed: signedOut?.confirmed === true, goals: box.goals.length };
  setPurchaseTrackerUser("buyer");
  await pollAndDispatchInvoice("1214420054");
  return { mid, goals: box.goals.length, states: box.receipts.map((item) => item.body.state) };
});

const bad = results.filter((item) => item.name.startsWith("analytics") && item.goals !== 1);
console.log(JSON.stringify({ scenarios: results.length, analyticsGoalMisses: bad.length }));
if (results.some((item) => item.name === "counter unavailable confirms payment but does not send" && item.goals !== 0)) process.exitCode = 1;
