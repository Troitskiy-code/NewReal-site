/**
 * Browser Metrika purchase flows against a local Next server.
 * Intercepts all Yandex hosts before navigation. Never talks to counter 112171267.
 *
 *   TEST_BASE_URL=http://127.0.0.1:4017 npm run verify:metrika:browser
 * or the script starts `next dev` itself with synthetic env.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

const TEST_COUNTER = "999001";
const PORT = Number(process.env['METRIKA_TEST_PORT'] || 4027);
const SYNTHETIC_USER = "synthetic-metrika-user";

const MOCK_TAG = `
(function(){
  var prev = window.ym;
  window.__ymCalls = window.__ymCalls || [];
  window.ym = function(id, method) {
    var args = Array.prototype.slice.call(arguments, 2);
    window.__ymCalls.push({ id: id, method: method, args: args });
    if (method === "init") {
      window["yaCounter" + id] = { id: id };
      setTimeout(function(){ window.dispatchEvent(new Event("yacounter" + id + "inited")); }, 20);
    }
    if (method === "reachGoal") {
      var goal = args[0];
      window.__ymHold = window.__ymHold || {};
      var cb = null;
      for (var i = 0; i < args.length; i++) if (typeof args[i] === "function") cb = args[i];
      if (window.__ymHold[goal]) { window.__ymPending = window.__ymPending || {}; window.__ymPending[goal] = cb; return; }
      if (cb) setTimeout(cb, 15);
    }
  };
  if (prev && prev.a) {
    prev.a.forEach(function(item){ window.ym.apply(null, item); });
  }
})();
`;

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

function syntheticEnv(base: Record<string, string | undefined> = process.env) {
  const isolated = { ...base };
  for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    if (existsSync(file)) for (const match of readFileSync(file, "utf8").matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) isolated[match[1]] = "";
  }
  return {
    ...isolated,
    PORT: String(PORT),
    NEXTAUTH_SECRET: "synthetic_metrika_browser_secret_not_prod",
    NEXTAUTH_URL: `http://127.0.0.1:${PORT}`,
    DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
    DIRECT_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
    NEXT_PUBLIC_YANDEX_METRIKA_ID: TEST_COUNTER,
    LOGTAIL_SOURCE_TOKEN: "",
    LOGTAIL_INGESTING_HOST: "",
    RESEND_API_KEY: "",
    ROBOKASSA_PASSWORD: "",
    GOOGLE_CLIENT_SECRET: "",
    STRIPE_SECRET_KEY: "",
    CRON_SECRET: "",
  };
}

async function loadPlaywright() {
  try {
    return require("playwright") as typeof import("playwright");
  } catch {
    try {
      return require("playwright-core") as typeof import("playwright-core");
    } catch {
      return null;
    }
  }
}

async function waitForServer(url: string, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status > 0) return;
    } catch {
      /* keep waiting */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Server did not start: ${url}`);
}

async function maybeStartNext(): Promise<{ base: string; child?: ChildProcess }> {
  const existing = (process.env['TEST_BASE_URL'] ?? "").replace(/\/$/, "");
  if (existing) {
    if (/newvers\.ai|112171267/i.test(existing)) {
      throw new Error("Refusing TEST_BASE_URL that looks like production");
    }
    return { base: existing };
  }
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: process.cwd(),
    env: syntheticEnv(),
    stdio: "pipe",
    windowsHide: true,
  });
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  const base = `http://127.0.0.1:${PORT}`;
  await waitForServer(base);
  return { base, child };
}

const statusStore = new Map<string, { remainingPending: number; payload: Record<string, unknown>; status?: number }>();
let sessionUser: { id: string; email: string } | null = { id: SYNTHETIC_USER, email: "metrika@example.test" };

async function installRoutes(
  context: { route: (url: string | RegExp, handler: (route: import("playwright").Route) => Promise<void>) => Promise<void> },
  options: { failPrimary?: boolean; failAll?: boolean }
) {
  await context.route(/mc\.yandex\.com\/metrika\/tag\.js/, async (route) => {
    if (options.failPrimary || options.failAll) {
      await route.abort("connectionrefused");
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/javascript", body: MOCK_TAG });
  });
  await context.route(/mc\.yandex\.ru\/metrika\/tag\.js/, async (route) => {
    if (options.failAll) {
      await route.abort("connectionrefused");
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/javascript", body: MOCK_TAG });
  });
  await context.route(/mc\.yandex\.(com|ru)\//, async (route) => {
    if (route.request().url().includes("tag.js")) {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await context.route("**/api/auth/session", async (route) => {
    if (!sessionUser) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: sessionUser }),
    });
  });
  await context.route("**/api/payment/status**", async (route) => {
    const url = new URL(route.request().url());
    const invId = url.searchParams.get("invId") || "";
    const entry = statusStore.get(invId);
    if (entry?.status) {
      await route.fulfill({ status: entry.status, contentType: "application/json", body: JSON.stringify({ error: "status" }) });
      return;
    }
    if (!entry) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "pending", invId }) });
      return;
    }
    if (entry.remainingPending > 0) {
      entry.remainingPending -= 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "pending", invId }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(entry.payload) });
  });
}

async function collectCalls(page: import("playwright").Page) {
  return page.evaluate(() => (window as unknown as { __ymCalls?: Array<{ method: string; args: unknown[] }> }).__ymCalls ?? []);
}

async function goalNames(page: import("playwright").Page) {
  const calls = await collectCalls(page);
  return calls.filter((c) => c.method === "reachGoal").map((c) => String(c.args[0]));
}

async function waitForGoal(page: import("playwright").Page, goal: string, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const names = await goalNames(page);
    if (names.includes(goal)) return names;
    await page.waitForTimeout(200);
  }
  return goalNames(page);
}

async function main() {
  const pw = await loadPlaywright();
  if (!pw) {
    console.error("FAIL: playwright is not installed");
    process.exit(1);
  }

  const { base, child } = await maybeStartNext();
  const browser = await pw.chromium.launch({ headless: true, channel: process.env['METRIKA_TEST_BROWSER_CHANNEL'] });
  const requests: string[] = [];
  try {
    const context = await browser.newContext({
      locale: "ru-RU",
      extraHTTPHeaders: { "Accept-Language": "ru" },
    });
    context.on("request", (req) => requests.push(req.url()));
    await installRoutes(context, {});
    statusStore.set("1001", {
      remainingPending: 0,
      payload: { status: "confirmed", invId: "1001", kind: "purchase", amountRub: 300 },
    });
    const page = await context.newPage();
    await page.goto(`${base}/ru/coins?InvId=1001&payment=success&type=vc&plan=dialog`, { waitUntil: "domcontentloaded" });
    const vcGoals = await waitForGoal(page, "vc_purchase_success");
    const inits = (await collectCalls(page)).filter((c) => c.method === "init");
    assert(inits.length === 1, "primary path: single init");
    assert(vcGoals.filter((g) => g === "vc_purchase_success").length === 1, "RU VC sends one purchase goal");
    assert(!vcGoals.includes("subscription_success"), "VC does not send subscription goals");
    assert(!requests.some((url) => url.includes("112171267")), "production counter id was not used");

    statusStore.set("1002", {
      remainingPending: 0,
      payload: { status: "confirmed", invId: "1002", kind: "subscription", planId: "dialog", amountRub: 499 },
    });
    await page.goto(`${base}/en/pricing?InvId=1002&payment=success&type=vc&plan=universe`, { waitUntil: "domcontentloaded" });
    await waitForGoal(page, "subscription_dialog");
    const subGoals = await goalNames(page);
    assert(subGoals.includes("subscription_success") && subGoals.includes("subscription_dialog"), "EN subscription uses server plan, not query plan");
    assert(!subGoals.includes("subscription_universe"), "query universe is ignored");

    statusStore.set("1008", {
      remainingPending: 0,
      payload: { status: "confirmed", invId: "1008", kind: "subscription", planId: "universe", amountRub: 2499 },
    });
    await page.goto(`${base}/ru/pricing?InvId=1008`, { waitUntil: "domcontentloaded" });
    await waitForGoal(page, "subscription_universe");
    const universeGoals = await goalNames(page);
    assert(universeGoals.includes("subscription_success") && universeGoals.includes("subscription_universe"), "RU universe sends success + plan goals");
    await context.close();

    const fallbackCtx = await browser.newContext({
      locale: "ru-RU",
      extraHTTPHeaders: { "Accept-Language": "ru" },
    });
    fallbackCtx.on("request", (req) => requests.push(req.url()));
    await installRoutes(fallbackCtx, { failPrimary: true });
    statusStore.set("1003", {
      remainingPending: 0,
      payload: { status: "confirmed", invId: "1003", kind: "subscription", planId: "story", amountRub: 1299 },
    });
    const fallbackPage = await fallbackCtx.newPage();
    await fallbackPage.goto(`${base}/ru/pricing?InvId=1003`, { waitUntil: "domcontentloaded" });
    await waitForGoal(fallbackPage, "subscription_history", 10000);
    const fallbackReqs = requests.filter((url) => url.includes("metrika/tag.js"));
    assert(fallbackReqs.some((url) => url.includes("mc.yandex.com")), "primary tag.js was requested");
    assert(fallbackReqs.some((url) => url.includes("mc.yandex.ru")), "fallback made a new tag.js request");
    const storyGoals = await goalNames(fallbackPage);
    assert(storyGoals.includes("subscription_success") && storyGoals.includes("subscription_history"), "fallback init still sends story→history goals");
    await fallbackCtx.close();

    const downCtx = await browser.newContext({
      locale: "ru-RU",
      extraHTTPHeaders: { "Accept-Language": "ru" },
    });
    await installRoutes(downCtx, { failAll: true });
    statusStore.set("1004", {
      remainingPending: 0,
      payload: { status: "confirmed", invId: "1004", kind: "purchase", amountRub: 300 },
    });
    const downPage = await downCtx.newPage();
    await downPage.goto(`${base}/ru/coins?InvId=1004`, { waitUntil: "domcontentloaded" });
    await downPage.waitForTimeout(2500);
    assert((await goalNames(downPage)).length === 0, "both sources down: no goals dispatched");
    const pending = await downPage.evaluate(() => Object.keys(localStorage).some((k) => k.includes("nv-metrika-pending")));
    assert(pending, "both sources down: pending event remains recoverable");
    await downPage.goto(`${base}/ru/coins`, { waitUntil: "domcontentloaded" });
    await downPage.waitForTimeout(1500);
    assert((await goalNames(downPage)).length === 0, "reload while Metrika is down still does not false-send");
    await downCtx.close();

    const lateCtx = await browser.newContext({
      locale: "ru-RU",
      extraHTTPHeaders: { "Accept-Language": "ru" },
    });
    await installRoutes(lateCtx, {});
    statusStore.set("1005", {
      remainingPending: 13,
      payload: { status: "confirmed", invId: "1005", kind: "purchase", amountRub: 300 },
    });
    const latePage = await lateCtx.newPage();
    await latePage.goto(`${base}/ru/coins?InvId=1005`, { waitUntil: "domcontentloaded" });
    await latePage.waitForTimeout(800);
    assert(!(await goalNames(latePage)).includes("vc_purchase_success"), "late webhook: no goal before confirmation");
    await latePage.goto(`${base}/ru/gallery`, { waitUntil: "domcontentloaded" });
    await latePage.waitForTimeout(500);
    await latePage.goto(`${base}/ru/coins`, { waitUntil: "domcontentloaded" });
    const lateGoals = await waitForGoal(latePage, "vc_purchase_success", 40000);
    assert(lateGoals.includes("vc_purchase_success"), "late confirmation after navigation still sends VC goal");
    await lateCtx.close();

    const spoofCtx = await browser.newContext({
      locale: "ru-RU",
      extraHTTPHeaders: { "Accept-Language": "ru" },
    });
    await installRoutes(spoofCtx, {});
    statusStore.set("1006", { remainingPending: 0, payload: { status: "pending", invId: "1006" } });
    statusStore.set("1007", { remainingPending: 0, status: 500, payload: {} });
    const spoofPage = await spoofCtx.newPage();
    await spoofPage.goto(`${base}/ru/pricing?InvId=1006&type=subscription&plan=universe`, { waitUntil: "domcontentloaded" });
    await spoofPage.waitForTimeout(2000);
    assert((await goalNames(spoofPage)).length === 0, "unconfirmed/foreign invoice sends no goals");
    await spoofPage.goto(`${base}/ru/pricing?InvId=1007`, { waitUntil: "domcontentloaded" });
    await spoofPage.waitForTimeout(1500);
    assert(!(await goalNames(spoofPage)).includes("subscription_success"), "5xx is not treated as confirmed");
    sessionUser = null;
    await spoofPage.goto(`${base}/ru/pricing?InvId=1002`, { waitUntil: "domcontentloaded" });
    await spoofPage.waitForTimeout(1500);
    const afterLogout = await goalNames(spoofPage);
    assert(!afterLogout.includes("subscription_success"), "logged-out session does not send purchase goals");
    await spoofCtx.close();
  } finally {
    await browser.close().catch(() => undefined);
    stopChild(child);
  }

  console.log("");
  if (failed > 0) {
    console.error(`Failed ${failed} of ${passed + failed}`);
    stopChild(child);
    process.exit(1);
  }
  console.log(`Passed ${passed} browser checks`);
  stopChild(child);
  process.exit(0);
}

function stopChild(child?: ChildProcess) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "browser-metrika failed");
  process.exit(1);
});
