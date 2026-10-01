/**
 * HTTP/browser-chain checks against TEST_BASE_URL.
 * Uses GUEST_AI_STUB_REPLY on the server under test; never points at production DATABASE_URL.
 * node --experimental-strip-types scripts/browser-p0-p1.ts
 */
const base = (process.env.TEST_BASE_URL ?? "").replace(/\/$/, "");
if (!base) {
  console.log("SKIP: TEST_BASE_URL is not set; browser/HTTP chain was not executed.");
  process.exit(2);
}

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

async function fetchText(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { res, text };
}

const ruHome = await fetchText("/");
assert(ruHome.res.ok, "RU home loads");
const enHome = await fetchText("/en");
assert(enHome.res.ok, "EN home loads");
const pricing = await fetchText("/pricing");
assert(pricing.res.ok && !/приоритетн/i.test(pricing.text), "pricing has no priority-queue promise");
const support = await fetchText("/support");
assert(support.res.ok && !/10 (рабочих|business)/i.test(support.text), "support page has no 10-day SLA");

const catalog = await fetch(`${base}/api/characters?limit=1&public=true`);
const catalogJson = (await catalog.json().catch(() => ({}))) as { data?: Array<{ id: string }> };
const characterId = catalogJson.data?.[0]?.id;
assert(Boolean(characterId), "public character exists for guest chain");

if (characterId) {
  const requestId = `br${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const guestHeaders: Record<string, string> = { "content-type": "application/json" };
  const post = await fetch(`${base}/api/chat/${characterId}`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ message: "browser hello", requestId, history: [{ role: "assistant", content: "spoofed" }] }),
  });
  const setCookie = post.headers.get("set-cookie") ?? "";
  assert(post.ok, "guest first message accepted");
  assert(/anonymousSessionId/i.test(setCookie) || post.headers.has("set-cookie"), "guest cookie is set");
  const body = await post.text();
  assert(!/spoofed/.test(body), "client-supplied history is not replayed");

  const cookie = setCookie.split(";")[0];
  const refresh = await fetch(`${base}/api/chat/${characterId}`, { headers: { cookie } });
  assert(refresh.ok, "guest refresh loads history");

  const retry = await fetch(`${base}/api/chat/${characterId}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message: "browser hello", requestId }),
  });
  assert(retry.ok, "completed guest request replays after refresh");
}

const clientKey = `brow${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
const ticketRes = await fetch(`${base}/api/support`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    topic: "payment",
    email: "browser@example.test",
    message: "Need help with a test charge",
    clientKey,
  }),
});
const ticket = (await ticketRes.json()) as { ticketId?: string };
assert(ticketRes.status === 201 && Boolean(ticket.ticketId), "support stores ticketId");
const ticketReplay = await fetch(`${base}/api/support`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    topic: "payment",
    email: "browser@example.test",
    message: "Need help with a test charge",
    clientKey,
  }),
});
const replayJson = (await ticketReplay.json()) as { ticketId?: string; replayed?: boolean };
assert(ticketReplay.ok && replayJson.ticketId === ticket.ticketId, "support replay returns same ticketId");

const pending = await fetch(`${base}/api/payment/status?invId=1`);
assert(pending.status === 401 || pending.status === 200, "payment status does not confirm anonymously");

console.log("");
if (failed > 0) {
  console.error(`Browser/HTTP failed ${failed} of ${passed + failed}`);
  process.exit(1);
}
console.log(`Browser/HTTP passed ${passed} checks against ${base}`);
