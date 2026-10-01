/**
 * Unit/regression checks without a database and without real secrets.
 * node --experimental-strip-types scripts/verify-p0-p1.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { redactSensitive, REDACTED, emailDomain } from "../src/lib/redactSensitive.ts";
import { sanitizeCallbackUrl } from "../src/lib/safeCallbackUrl.ts";
import {
  ANONYMOUS_COOKIE_MAX_AGE,
  ANONYMOUS_TTL_DAYS,
} from "../src/lib/anonymousCookie.ts";
import {
  decideGuestClaim,
  guestPayloadHash,
  canFinalizeAttempt,
  canRefundOnce,
  messagesEligibleForTransfer,
} from "../src/lib/guestRequestPolicy.ts";
import { estimatePlanRequestsFromModels } from "../src/lib/requestEstimate.ts";
import { parseSupportTicket } from "../src/lib/supportTicket.ts";
import { SUBSCRIPTION_PLANS } from "../src/lib/chatEconomy.ts";
import { getRequiredEnv } from "../src/lib/requireEnv.ts";
import { shouldPersistEmbeddings } from "../src/lib/ragEligibility.ts";

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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === ".next") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|js|mjs|cjs|md|sql|json)$/.test(entry)) acc.push(full);
  }
  return acc;
}

console.log("P0 structural secret scan");
const scanRoots = ["src", "scripts", "prisma", "docs"].map((dir) => join(root, dir));
const authSrc = readFileSync(join(root, "src/lib/auth.ts"), "utf8");
const prismaSrc = readFileSync(join(root, "src/lib/prisma.js"), "utf8");
assert(!/secret:\s*["'][a-f0-9]{32,}/i.test(authSrc), "auth.ts has no hex secret literal");
assert(authSrc.includes("getRequiredEnv(\"NEXTAUTH_SECRET\")"), "auth.ts requires NEXTAUTH_SECRET");
assert(!prismaSrc.includes("FALLBACK_URL"), "prisma.js has no DATABASE_URL fallback");
assert(prismaSrc.includes("getRequiredEnv(\"DATABASE_URL\")"), "prisma.js requires DATABASE_URL");
assert(!/postgresql:\/\/[^:]+:[^@]+@/.test(prismaSrc), "prisma.js has no inline DSN credentials");

const skipScan = new Set([".env", ".env.local", ".env.production"]);
let leakedPatternHits = 0;
for (const scanRoot of scanRoots) {
  for (const file of walk(scanRoot)) {
    const base = file.split(/[/\\]/).pop() ?? "";
    if (skipScan.has(base) || file.endsWith(".png") || file.endsWith(".webp")) continue;
    const text = readFileSync(file, "utf8");
    if (/FALLBACK_URL/.test(text) && file.endsWith("prisma.js")) leakedPatternHits += 1;
    if (/secret:\s*["'][a-f0-9]{48,}/.test(text) && !file.includes("verify") && !file.includes("node_modules")) {
      leakedPatternHits += 1;
    }
  }
}
assert(leakedPatternHits === 0, "working tree scan finds no hex secret assignments or FALLBACK_URL");

const verifySrc = readFileSync(join(root, "scripts/verify-p0-p1.ts"), "utf8");
const sf = ts.createSourceFile("verify.ts", verifySrc, ts.ScriptTarget.Latest, true);
let longHexLiterals = 0;
ts.forEachChild(sf, function visit(node) {
  if (ts.isStringLiteral(node) && /^[a-f0-9]{32,}$/i.test(node.text)) longHexLiterals += 1;
  ts.forEachChild(node, visit);
});
assert(longHexLiterals === 0, "this test file contains no long hex secret literals");

console.log("P0 redaction");
const nested = redactSensitive({
  user: { password: "secret-pass", profile: { access_token: "tok", nested: { apiKey: "k" } } },
  url: "postgresql://postgres:hunter2@localhost:5432/db",
});
const asRecord = nested as Record<string, unknown>;
const user = asRecord.user as Record<string, unknown>;
const profile = user.profile as Record<string, unknown>;
assert(user.password === REDACTED, "redacts nested password");
assert(profile.access_token === REDACTED, "redacts nested access_token");
assert(asRecord.url === REDACTED || String(asRecord.url).includes(REDACTED), "redacts connection string");
const err = redactSensitive(new Error("password=SYNTHETIC_TEST_PASSWORD token=SYNTHETIC_TEST_TOKEN")) as Record<string, unknown>;
assert(!String(err.message).includes("SYNTHETIC_TEST_PASSWORD"), "redacts secrets inside Error.message");
const prismaLike = redactSensitive({ code: "P2002", clientVersion: "5", meta: { target: ["password"] }, message: "password=x" });
assert((prismaLike as Record<string, unknown>).category === "prisma", "prisma-like errors become allowlisted fields");
const cycle: Record<string, unknown> = { a: 1 };
cycle.self = cycle;
assert((redactSensitive(cycle) as Record<string, unknown>).self === "[circular]", "handles cycles");
assert(emailDomain("user@newvers.ai") === "newvers.ai", "emailDomain keeps host only");

const missingKey = `NV_P0P1_MISSING_${Date.now()}`;
delete process.env[missingKey];
let missingNameOnly = false;
let missingDetail = "no-throw";
try {
  const value = getRequiredEnv(missingKey);
  missingDetail = `no-throw:${typeof value}`;
} catch (error) {
  missingDetail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  missingNameOnly = missingDetail.includes(missingKey) && !/postgresql:\/\//i.test(missingDetail) && !/password=/i.test(missingDetail);
}
assert(missingNameOnly, `missing env error names the variable only (${missingDetail})`);

console.log("P1 callbackUrl");
assert(sanitizeCallbackUrl("/chat/abc") === "/chat/abc", "allows relative chat path");
assert(sanitizeCallbackUrl("https://evil.test") === "/", "rejects absolute http");
assert(sanitizeCallbackUrl("//evil.test") === "/", "rejects protocol-relative");
assert(sanitizeCallbackUrl("/\\evil") === "/", "rejects backslash");
assert(sanitizeCallbackUrl("%2f%2fevil.test") === "/", "rejects double-encoded protocol-relative");
assert(sanitizeCallbackUrl("/login") === "/", "rejects auth routes as callback");

console.log("P1 guest claim policy");
const baseSession = { sessionId: "s".repeat(16), messagesCount: 0, transferredToUserId: null, expired: false };
const hash = guestPayloadHash("char-a", "hello");
assert(decideGuestClaim({ session: { ...baseSession, transferredToUserId: "u1" }, existing: null, characterId: "char-a", payloadHash: hash, now: new Date(), quotaLimit: 5 }).kind === "revoked", "transferred session is revoked");
const create = decideGuestClaim({ session: baseSession, existing: null, characterId: "char-a", payloadHash: hash, now: new Date(), quotaLimit: 5 });
assert(create.kind === "run" && create.mode === "create", "new request is created");
const completed = {
  requestId: "r1",
  sessionId: baseSession.sessionId,
  characterId: "char-a",
  payloadHash: hash,
  status: "completed" as const,
  attempt: 1,
  leaseUntil: null,
  reservedQuota: true,
  refundedAt: null,
  userContent: "hello",
  assistantContent: "hi",
  userMessageId: "u",
  assistantMessageId: "a",
  remainingMessages: 4,
};
assert(decideGuestClaim({ session: { ...baseSession, messagesCount: 5 }, existing: completed, characterId: "char-a", payloadHash: hash, now: new Date(), quotaLimit: 5 }).kind === "replay", "completed last free request can replay without quota");
const failedRequest = { ...completed, status: "failed" as const, assistantContent: null, refundedAt: new Date() };
const retry = decideGuestClaim({ session: { ...baseSession, messagesCount: 4 }, existing: failedRequest, characterId: "char-a", payloadHash: hash, now: new Date(), quotaLimit: 5 });
assert(retry.kind === "run" && retry.mode === "retry", "failed request can retry");
assert(decideGuestClaim({ session: baseSession, existing: completed, characterId: "char-b", payloadHash: hash, now: new Date(), quotaLimit: 5 }).kind === "conflict", "other character conflicts");
assert(!canFinalizeAttempt({ status: "pending", attempt: 1 }, 2), "stale attempt cannot finalize");
assert(canRefundOnce({ reservedQuota: true, refundedAt: null }) && !canRefundOnce({ reservedQuota: true, refundedAt: new Date() }), "refund is once");
assert(messagesEligibleForTransfer([{ id: "1", requestId: "r1", role: "user" }], [{ requestId: "r1", status: "pending" }]).length === 0, "pending user row is not transferred");
const anonChatSrc = readFileSync(join(root, "src/lib/anonymousChat.ts"), "utf8");
assert(!anonChatSrc.includes("body.history") && !anonChatSrc.includes("body?.history"), "guest chat does not trust client history");

console.log("P1 tariffs and estimate");
assert(SUBSCRIPTION_PLANS.find((p) => p.id === "universe")?.monthlyPrice === 3499, "Universe price unchanged");
assert(SUBSCRIPTION_PLANS.every((plan) => !plan.features.some((item) => /приоритетн/i.test(item))), "no priority-queue promise");
const dynamic = estimatePlanRequestsFromModels(30000, [
  { id: "a", displayName: "Cheap", priceVC: 5, isActive: true },
  { id: "b", displayName: "Dear", priceVC: 50, isActive: true },
]);
assert(dynamic.available && dynamic.baseModel === 6000 && dynamic.premiumModel === 600, "estimate follows catalog prices");
assert(!estimatePlanRequestsFromModels(30000, []).available, "empty catalog does not invent prices");

console.log("P1 support parse");
assert(parseSupportTicket({ topic: "payment", email: "a@b.com", message: "Need help with a charge" }).ok, "valid ticket");
assert(!parseSupportTicket({ topic: "payment", email: "bad", message: "Need help with a charge" }).ok, "invalid email");

const previousRag = process.env.ENABLE_RAG_EMBEDDINGS;
process.env.ENABLE_RAG_EMBEDDINGS = "false";
assert(shouldPersistEmbeddings("universe", true) === true, "paid eligible plan persists RAG even when global flag is off");
assert(shouldPersistEmbeddings("start", true) === false, "free plan does not persist RAG when flag is off");
process.env.ENABLE_RAG_EMBEDDINGS = "true";
assert(shouldPersistEmbeddings("start", false) === true, "global RAG flag enables embeddings independently");
if (previousRag === undefined) delete process.env.ENABLE_RAG_EMBEDDINGS;
else process.env.ENABLE_RAG_EMBEDDINGS = previousRag;

console.log("");
if (failed > 0) {
  console.error(`Failed ${failed} of ${passed + failed}`);
  process.exit(1);
}
console.log(`Passed ${passed} checks`);
