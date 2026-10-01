// Expected-behavior checks for repaired guest/log paths. No real secrets.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert/strict");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");

function load(relative) {
  const filename = path.join(root, relative);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    filename
  );
  return mod.exports;
}

const verifySource = fs.readFileSync(path.join(root, "scripts/verify-p0-p1.ts"), "utf8");
const syntax = ts.createSourceFile("verify.ts", verifySource, ts.ScriptTarget.Latest, true);
let longHex = 0;
ts.forEachChild(syntax, function visit(node) {
  if (ts.isStringLiteral(node) && /^[a-f0-9]{32,}$/i.test(node.text)) longHex += 1;
  ts.forEachChild(node, visit);
});
assert.equal(longHex, 0, "verify script must not embed long hex secrets");

const { redactSensitive } = load("src/lib/redactSensitive.ts");
const synthetic = redactSensitive(new Error("password=SYNTHETIC_TEST_PASSWORD token=SYNTHETIC_TEST_TOKEN"));
assert.equal(String(synthetic.message).includes("SYNTHETIC_TEST_PASSWORD"), false);

const { decideGuestClaim, guestPayloadHash } = load("src/lib/guestRequestPolicy.ts");
const hash = guestPayloadHash("character-A", "test");
const failed = decideGuestClaim({
  session: { sessionId: "offline-session-12345", messagesCount: 1, transferredToUserId: null, expired: false },
  existing: {
    requestId: "offline-request-12345",
    sessionId: "offline-session-12345",
    characterId: "character-A",
    payloadHash: hash,
    status: "failed",
    attempt: 1,
    leaseUntil: null,
    reservedQuota: true,
    refundedAt: new Date(),
    userContent: "test",
    assistantContent: null,
    userMessageId: "u",
    assistantMessageId: null,
    remainingMessages: 4,
  },
  characterId: "character-A",
  payloadHash: hash,
  now: new Date(),
  quotaLimit: 5,
});
assert.equal(failed.kind, "run");
assert.equal(failed.mode, "retry");

const transferred = decideGuestClaim({
  session: { sessionId: "offline-session-12345", messagesCount: 1, transferredToUserId: "user-A", expired: false },
  existing: {
    requestId: "offline-request-12345",
    sessionId: "offline-session-12345",
    characterId: "character-A",
    payloadHash: hash,
    status: "completed",
    attempt: 1,
    leaseUntil: null,
    reservedQuota: true,
    refundedAt: null,
    userContent: "private stored question",
    assistantContent: "private stored reply",
    userMessageId: "u",
    assistantMessageId: "a",
    remainingMessages: 4,
  },
  characterId: "different-character",
  payloadHash: hash,
  now: new Date(),
  quotaLimit: 5,
});
assert.equal(transferred.kind, "revoked");
console.log("review-repro: repaired retry/revoke/redaction expectations hold");
