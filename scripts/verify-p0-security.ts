/**
 * Isolated P0 security regressions. Synthetic values only.
 * Does not load application Prisma/auth modules that require live env.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { redactSensitive, redactText, REDACTED, safeErrorFields, UNAVAILABLE } from "@/lib/redactSensitive";
import { errorLog, formatErrorLog, formatSafeLog, infoLog, setDiagnosticSink, toSafeDiagnostic as loggerToSafeDiagnostic } from "@/lib/logger";
import { getRequiredEnv } from "@/lib/requireEnv";
import {
  reportAuthFailure,
  reportPrismaFailure,
  toSafeDiagnostic,
  withAuthErrorReport,
} from "@/lib/safeDiagnostics";
import { inspectCronSecrets } from "@/lib/cronAuth";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");

const SYN = {
  bearer: "SYNTHETIC_AUTH_VALUE",
  password: "SYNTHETIC_PASSWORD_VALUE",
  token: "SYNTHETIC_TOKEN_VALUE",
  dsnUser: "synthetic",
  dsnPass: "synthetic",
};

const DSN = `postgresql://${SYN.dsnUser}:${SYN.dsnPass}@localhost/test`;

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

function leaked(haystack: string, ...secrets: string[]): boolean {
  return secrets.some((secret) => haystack.includes(secret));
}

function dump(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return UNAVAILABLE;
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

console.log("P0 redaction strings");
const bearerLine = redactText(`Authorization: Bearer ${SYN.bearer}`);
assert(!leaked(bearerLine, SYN.bearer), "Bearer token is removed");
assert(bearerLine.includes(REDACTED), "Bearer replacement uses redacted marker");

const doubleQuoted = redactText(`password="${SYN.password}"`);
assert(!leaked(doubleQuoted, SYN.password), "double-quoted password is removed");
const singleQuoted = redactText(`password='${SYN.password}'`);
assert(!leaked(singleQuoted, SYN.password), "single-quoted password is removed");
const bare = redactText(`password=${SYN.password}`);
assert(!leaked(bare, SYN.password), "bare password assignment is removed");
const bareToken = redactText(`token=${SYN.token}`);
assert(!leaked(bareToken, SYN.token), "bare token assignment is removed");

const dsnThenToken = redactText(`${DSN} token=${SYN.token}`);
assert(!leaked(dsnThenToken, SYN.dsnPass, SYN.token, "postgresql://"), "DSN then token both redacted");
const tokenThenDsn = redactText(`token=${SYN.token} ${DSN}`);
assert(!leaked(tokenThenDsn, SYN.dsnPass, SYN.token, "postgresql://"), "token then DSN both redacted");

const many = redactText(`${DSN} ${DSN} password="${SYN.password}" token=${SYN.token} Authorization: Bearer ${SYN.bearer}`);
assert(
  !leaked(many, SYN.dsnPass, SYN.password, SYN.token, SYN.bearer, "postgresql://"),
  "multiple DSN and secrets in one string"
);

const jsonPassword = redactText(JSON.stringify({ password: SYN.password }));
assert(!leaked(jsonPassword, SYN.password) && jsonPassword.includes(REDACTED), "JSON quoted password key is removed");
const jsonMany = redactText(JSON.stringify({ password: SYN.password, token: SYN.token, keep: "ok" }));
assert(!leaked(jsonMany, SYN.password, SYN.token) && jsonMany.includes("ok"), "JSON multiple quoted secrets are removed");
const jsonSingle = redactText(`{'password':'${SYN.password}'}`);
assert(!leaked(jsonSingle, SYN.password), "JSON single-quoted password key is removed");

console.log("P0 nested keys and structures");
const nested = redactSensitive({
  Authorization: `Bearer ${SYN.bearer}`,
  COOKIE: `sid=${SYN.token}`,
  Password: SYN.password,
  inner: { TOKEN: SYN.token, keep: "ok" },
});
const nestedDump = dump(nested);
assert(!leaked(nestedDump, SYN.bearer, SYN.password, SYN.token), "nested Authorization/cookie/password/token redacted");
assert((nested as { inner: { keep: string } }).inner.keep === "ok", "non-sensitive nested field kept");

const mapDump = dump(
  redactSensitive(new Map<string, unknown>([["password", SYN.password], ["visible", 1]]))
);
assert(!leaked(mapDump, SYN.password) && mapDump.includes("1"), "Map password key redacted");

const cycleObj: Record<string, unknown> = { keep: true };
cycleObj.self = cycleObj;
const cycled = redactSensitive(cycleObj) as Record<string, unknown>;
assert(cycled.self === "[circular]", "cyclic object marked circular");

const cycleArr: unknown[] = [];
cycleArr.push(cycleArr);
assert((redactSensitive(cycleArr) as unknown[])[0] === "[circular]", "cyclic array marked circular");

const mixed: { items: unknown[] } = { items: [] };
mixed.items.push(mixed);
assert(((redactSensitive(mixed) as { items: unknown[] }).items[0] as string) === "[circular]", "mixed cycle marked circular");

const nestedArr = redactSensitive([{ token: SYN.token }, ["ok"]]);
assert(!leaked(dump(nestedArr), SYN.token), "nested array token redacted");

console.log("P0 error shapes");
const generic = redactSensitive(new Error(`password=${SYN.password}`)) as Record<string, unknown>;
assert(generic.category === "error", "generic Error is categorized");
assert(generic.message === undefined, "generic Error omits message");
assert(generic.stack === undefined, "generic Error omits stack");
assert(!leaked(dump(generic), SYN.password), "generic Error dump has no password");

const prismaLike = {
  code: "P2002",
  clientVersion: "5.22.0",
  meta: { target: ["password"], query: DSN },
  message: `password=${SYN.password}`,
};
const prismaSafe = redactSensitive(prismaLike) as Record<string, unknown>;
assert(prismaSafe.category === "prisma" && prismaSafe.code === "P2002", "prisma-like allowlists code");
assert(prismaSafe.meta === undefined && prismaSafe.message === undefined, "prisma-like omits meta and message");
assert(!leaked(dump(prismaSafe), SYN.password, SYN.dsnPass), "prisma-like dump has no secrets");

const axiosLike = {
  isAxiosError: true,
  code: "ERR_BAD_REQUEST",
  config: { headers: { Authorization: `Bearer ${SYN.bearer}` }, data: { password: SYN.password } },
  response: { status: 401, data: { token: SYN.token } },
};
const axiosSafe = redactSensitive(axiosLike) as Record<string, unknown>;
assert(axiosSafe.category === "http" && axiosSafe.status === 401, "axios-like keeps numeric status");
assert(axiosSafe.config === undefined && axiosSafe.response === undefined, "axios-like omits config/response bodies");
assert(!leaked(dump(axiosSafe), SYN.bearer, SYN.password, SYN.token), "axios-like dump has no secrets");

const oauthLike = {
  error: "invalid_grant",
  error_description: `token=${SYN.token}`,
  error_uri: "https://example.test",
};
const oauthSafe = redactSensitive(oauthLike) as Record<string, unknown>;
assert(oauthSafe.category === "oauth" && oauthSafe.code === "invalid_grant", "oauth-like allowlists error code");
assert(oauthSafe.error_description === undefined, "oauth-like omits description");
assert(!leaked(dump(oauthSafe), SYN.token), "oauth-like dump has no token");

const withCause = new Error("outer");
(withCause as Error & { cause: unknown }).cause = { password: SYN.password };
assert(!leaked(dump(redactSensitive(withCause)), SYN.password), "Error.cause is not copied into diagnostic");

const exploding: Record<string, unknown> = {};
Object.defineProperty(exploding, "password", {
  enumerable: true,
  get() {
    throw new Error(`token=${SYN.token}`);
  },
});
const exploded = redactSensitive(exploding);
assert(exploded === UNAVAILABLE || !leaked(dump(exploded), SYN.token), "serialization failure does not leak");

console.log("P0 diagnostic contract");
const plainEnvelope = toSafeDiagnostic({
  message: SYN.password,
  stack: SYN.token,
  meta: { queryArgs: SYN.password },
});
assert(plainEnvelope.category === "error", "plain object diagnostic is categorized");
assert(
  plainEnvelope.message === undefined && plainEnvelope.stack === undefined && plainEnvelope.meta === undefined,
  "plain object diagnostic omits message/stack/meta"
);
assert(!leaked(dump(plainEnvelope), SYN.password, SYN.token), "plain object diagnostic has no secrets");

const thrownString = toSafeDiagnostic(SYN.password);
assert(thrownString.category === "error" && Object.keys(thrownString).length === 1, "unknown string diagnostic has no content");
assert(!leaked(dump(thrownString), SYN.password), "unknown string diagnostic has no secrets");

const named = new Error("safe");
named.name = SYN.password;
const namedFields = safeErrorFields(named);
assert(namedFields.name === undefined, "unknown Error.name is omitted");
assert(!leaked(dump(namedFields), SYN.password), "unknown Error.name dump has no secrets");

const throwingProxy = new Proxy(
  {},
  {
    get() {
      throw new Error(`token=${SYN.token}`);
    },
  }
);
assert(!leaked(dump(toSafeDiagnostic(throwingProxy)), SYN.token), "diagnostic fallback survives getter/proxy failure");

console.log("P0 logger console + sink");
const consoleLines: string[] = [];
const sinkLines: string[] = [];
const originalError = console.error;
const originalInfo = console.info;
console.error = (...args: unknown[]) => {
  consoleLines.push(args.map(String).join(" "));
};
console.info = (...args: unknown[]) => {
  consoleLines.push(args.map(String).join(" "));
};
setDiagnosticSink({
  debug(message) {
    sinkLines.push(message);
  },
  info(message) {
    sinkLines.push(message);
  },
  error(message) {
    sinkLines.push(message);
  },
  flush() {
    return undefined;
  },
});

try {
  errorLog("AuthTest", `Authorization: Bearer ${SYN.bearer}`, { password: SYN.password });
  infoLog("AuthTest", `${DSN} token=${SYN.token}`);
  const formatted = formatSafeLog("AuthTest", [`password="${SYN.password}"`]);
  assert(!leaked(formatted, SYN.password), "formatSafeLog redacts quoted password");
  assert(consoleLines.length > 0 && sinkLines.length > 0, "console and sink both received events");
  assert(
    consoleLines.every((line) => !leaked(line, SYN.bearer, SYN.password, SYN.token, SYN.dsnPass)),
    "console output has no synthetic secrets"
  );
  assert(
    sinkLines.every((line) => !leaked(line, SYN.bearer, SYN.password, SYN.token, SYN.dsnPass)),
    "sink output has no synthetic secrets"
  );
  assert(consoleLines[0] === sinkLines[0], "console and sink share the same first error representation");

  errorLog("Auth", "failure", { message: SYN.password });
  errorLog("Auth", "failure", { name: "Error", message: SYN.token });
  errorLog("Auth", "failure", { userId: "synthetic-user", error: SYN.password });
  const unknownErrorOut = [...consoleLines, ...sinkLines].join("\n");
  assert(!leaked(unknownErrorOut, SYN.password, SYN.token), "errorLog unknown error shapes have no synthetic secrets");
  assert(
    loggerToSafeDiagnostic({ message: SYN.password }).message === undefined,
    "toSafeDiagnostic from logger omits message-only content"
  );
} finally {
  console.error = originalError;
  console.info = originalInfo;
}

console.log("P0 errorLog cycle guards");
{
  const selfOnce: unknown[] = [];
  selfOnce.push(selfOnce);
  const selfTwice: unknown[] = [];
  selfTwice.push(selfTwice, selfTwice);
  const mixed: { items: unknown[] } = { userId: "synthetic-user", items: [] };
  mixed.items.push(mixed);
  const cyclicMap = new Map<string, unknown>();
  cyclicMap.set("userId", "synthetic-user");
  cyclicMap.set("self", cyclicMap);
  let deep: unknown = { userId: "leaf" };
  for (let i = 0; i < 12; i += 1) deep = [deep, deep];

  const cycleDump = [
    formatErrorLog("Cycle", ["constant event", selfOnce]),
    formatErrorLog("Cycle", ["constant event", selfTwice]),
    formatErrorLog("Cycle", ["constant event", mixed]),
    formatErrorLog("Cycle", ["constant event", cyclicMap]),
    formatErrorLog("Cycle", ["constant event", deep]),
  ].join("\n");
  assert(cycleDump.includes("[circular]") || cycleDump.includes("truncated"), "cyclic errorLog args are stubbed");
  assert(!leaked(cycleDump, SYN.password, SYN.token), "cyclic errorLog dump has no synthetic secrets");

  const cycleLines: string[] = [];
  const cycleSink: string[] = [];
  console.error = (...args: unknown[]) => {
    cycleLines.push(args.map(String).join(" "));
  };
  setDiagnosticSink({
    debug(message) {
      cycleSink.push(message);
    },
    info(message) {
      cycleSink.push(message);
    },
    error(message) {
      cycleSink.push(message);
    },
  });
  try {
    errorLog("Cycle", "constant event", selfTwice);
    assert(cycleLines.length > 0 && cycleSink.length > 0, "cyclic errorLog reached console and sink");
    assert(
      [...cycleLines, ...cycleSink].every((line) => !leaked(line, SYN.password, SYN.token)),
      "cyclic errorLog channels have no synthetic secrets"
    );
  } finally {
    console.error = originalError;
    setDiagnosticSink(null);
  }

  const hang = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      "./scripts/alias-register.mjs",
      "--input-type=module",
      "-e",
      "import { formatErrorLog } from './src/lib/logger.ts'; const a=[]; a.push(a,a); formatErrorLog('Probe', ['constant event', a]); console.log('DONE');",
    ],
    { cwd: root, encoding: "utf8", timeout: 3000, env: { ...process.env, LOGTAIL_SOURCE_TOKEN: "", LOGTAIL_INGESTING_HOST: "" } }
  );
  assert(hang.status === 0 && (hang.stdout ?? "").includes("DONE") && hang.error?.code !== "ETIMEDOUT", "cyclic array formatter finishes before timeout");
}

console.log("P0 auth/prisma diagnostic helpers");
const helperLines: string[] = [];
console.error = (...args: unknown[]) => {
  helperLines.push(args.map(String).join(" "));
};
try {
  reportAuthFailure("Adapter.linkAccount", {
    error: "invalid_grant",
    error_description: `Bearer ${SYN.bearer}`,
    access_token: SYN.token,
  });
  reportPrismaFailure("User.create", {
    code: "P2002",
    clientVersion: "5.22.0",
    meta: { query: DSN },
    message: `password=${SYN.password}`,
  });
  let thrown = false;
  try {
    await withAuthErrorReport("Adapter.createUser", async () => {
      throw Object.assign(new Error("link failed"), {
        error_description: `token=${SYN.token}`,
        error: "invalid_request",
      });
    });
  } catch {
    thrown = true;
  }
  assert(thrown, "withAuthErrorReport rethrows");
  assert(helperLines.some((line) => line.includes("Adapter.linkAccount")), "linkAccount helper used real logger");
  assert(helperLines.some((line) => line.includes("Adapter.createUser")), "createUser helper used real logger");
  assert(helperLines.some((line) => line.includes("User.create")), "prisma helper used real logger");
  assert(
    helperLines.every((line) => !leaked(line, SYN.bearer, SYN.password, SYN.token, SYN.dsnPass)),
    "auth/prisma helper output has no synthetic secrets"
  );
} finally {
  console.error = originalError;
}

console.log("P0 actual auth handlers with synthetic Prisma errors");
function loadIsolated(
  file: string,
  imports: Record<string, unknown>,
  extras: { fetch?: typeof fetch; process?: NodeJS.Process } = {}
) {
  const source = readFileSync(join(root, file), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const isolated = { exports: {} as Record<string, unknown> };
  const mockRequire = (id: string) => {
    if (Object.hasOwn(imports, id)) return imports[id];
    throw new Error(`Unmocked import ${id}`);
  };
  const isolatedProcess = extras.process ?? process;
  const isolatedFetch =
    extras.fetch ??
    (() => {
      throw new Error("Network forbidden in verify:p0-security");
    });
  const run = new Function("require", "module", "exports", "console", "process", "fetch", compiled) as (
    ...args: unknown[]
  ) => void;
  run(mockRequire, isolated, isolated.exports, console, isolatedProcess, isolatedFetch);
  return isolated.exports;
}

const handlerLines: string[] = [];
const handlerSink: string[] = [];
console.error = (...args: unknown[]) => {
  handlerLines.push(args.map(String).join(" "));
};
setDiagnosticSink({
  debug(message) {
    handlerSink.push(message);
  },
  info(message) {
    handlerSink.push(message);
  },
  error(message) {
    handlerSink.push(message);
  },
});
try {
  const fakePrismaError = () =>
    Object.assign(new Error(`Prisma invocation args: token="${SYN.token}" password="${SYN.password}"`), {
      name: "PrismaClientValidationError",
      clientVersion: "5.22.0",
    });
  const commonImports = {
    "next/server": {
      NextResponse: { json: (body: unknown, options: { status?: number } = {}) => ({ body, status: options.status ?? 200 }) },
    },
    "@/lib/apiI18n": { apiT: () => "safe_public_error", getApiLocale: () => "ru" },
    bcryptjs: { hash: async () => "SYNTHETIC_HASH" },
    "@/lib/logger": { errorLog, infoLog, debugLog: errorLog, toSafeDiagnostic },
  };

  const register = loadIsolated("src/app/api/auth/register/route.ts", {
    ...commonImports,
    "@/lib/prisma": { prisma: { user: { findUnique: async () => { throw fakePrismaError(); } } } },
    "@/lib/ensureUserConsent": { isAcceptedFlag: () => true, ensureUserConsentColumns: async () => {} },
    "@/lib/provisionNewUser": { applySignupBenefits: async () => {} },
    "@/lib/emailVerification": { createAndSendVerificationEmail: async () => {} },
  }) as { POST: (req: { json: () => Promise<unknown> }) => Promise<{ status: number; body: unknown }> };
  const registerRes = await register.POST({
    json: async () => ({
      email: "verify@example.test",
      password: SYN.password,
      acceptedTerms: true,
      acceptedOffer: true,
      acceptedRules: true,
    }),
  });
  assert(registerRes.status === 500, "register.POST returns safe 500 on Prisma throw");
  assert(!leaked(JSON.stringify(registerRes), SYN.password, SYN.token), "register.POST HTTP body has no synthetic secrets");

  const reset = loadIsolated("src/app/api/auth/reset-password/route.ts", {
    ...commonImports,
    "@/lib/prisma": { prisma: { passwordResetToken: { findUnique: async () => { throw fakePrismaError(); } } } },
  }) as { GET: (req: { nextUrl: URL }) => Promise<{ status: number; body: unknown }> };
  const resetRes = await reset.GET({ nextUrl: new URL(`http://localhost/reset?token=${SYN.token}`) });
  assert(resetRes.status === 500, "reset-password.GET returns safe 500 on Prisma throw");
  assert(!leaked(JSON.stringify(resetRes), SYN.password, SYN.token), "reset-password.GET HTTP body has no synthetic secrets");

  let robokassaRejected = false;
  const robokassa = loadIsolated(
    "src/lib/robokassa.ts",
    {
      crypto: require("node:crypto"),
      "crc-32": require("crc-32"),
      "@/lib/logger": { errorLog, infoLog, debugLog: errorLog, toSafeDiagnostic },
      "@/lib/i18nConfig": { withLocale: (_locale: string, url: string) => url },
    },
    {
      process: { env: { ROBOKASSA_MERCHANT_ID: "synthetic", ROBOKASSA_PASSWORD: "synthetic", ROBOKASSA_TEST_MODE: "1" } } as NodeJS.Process,
      fetch: (async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ password: SYN.password }),
      })) as unknown as typeof fetch,
    }
  ) as { chargeRobokassaRecurring: (opts: { previousInvoiceId: string; sum: number; desc: string }) => Promise<unknown> };
  try {
    await robokassa.chargeRobokassaRecurring({ previousInvoiceId: "synthetic-id", sum: 1, desc: "synthetic" });
  } catch {
    robokassaRejected = true;
  }
  assert(robokassaRejected, "Robokassa recurring charge rejects HTTP 400");

  const messageOnlyRegister = loadIsolated("src/app/api/auth/register/route.ts", {
    ...commonImports,
    "@/lib/prisma": { prisma: { user: { findUnique: async () => { throw { message: SYN.password }; } } } },
    "@/lib/ensureUserConsent": { isAcceptedFlag: () => true, ensureUserConsentColumns: async () => {} },
    "@/lib/provisionNewUser": { applySignupBenefits: async () => {} },
    "@/lib/emailVerification": { createAndSendVerificationEmail: async () => {} },
  }) as { POST: (req: { json: () => Promise<unknown> }) => Promise<{ status: number; body: unknown }> };
  const messageOnlyRegisterRes = await messageOnlyRegister.POST({
    json: async () => ({
      email: "verify@example.test",
      password: SYN.password,
      acceptedTerms: true,
      acceptedOffer: true,
      acceptedRules: true,
    }),
  });
  assert(messageOnlyRegisterRes.status === 500, "register.POST returns 500 on message-only throw");
  assert(!leaked(JSON.stringify(messageOnlyRegisterRes), SYN.password), "register.POST message-only HTTP body has no secrets");

  const messageOnlyReset = loadIsolated("src/app/api/auth/reset-password/route.ts", {
    ...commonImports,
    "@/lib/prisma": { prisma: { passwordResetToken: { findUnique: async () => { throw { message: SYN.token }; } } } },
  }) as { GET: (req: { nextUrl: URL }) => Promise<{ status: number; body: unknown }> };
  const messageOnlyResetRes = await messageOnlyReset.GET({ nextUrl: new URL("http://localhost/reset?token=synthetic") });
  assert(messageOnlyResetRes.status === 500, "reset-password.GET returns 500 on message-only throw");
  assert(!leaked(JSON.stringify(messageOnlyResetRes), SYN.token), "reset-password.GET message-only HTTP body has no secrets");

  const resend = loadIsolated("src/app/api/auth/resend-verification/route.ts", {
    ...commonImports,
    "next-auth/next": { getServerSession: async () => ({ user: { id: "synthetic-user" } }) },
    "@/lib/auth": { authOptions: {} },
    "@/lib/prisma": { prisma: { user: { findUnique: async () => ({ id: "synthetic-user", email: "verify@example.test" }) } } },
    "@/lib/emailVerification": {
      isEmailVerified: () => false,
      createAndSendVerificationEmail: async () => {
        throw SYN.password;
      },
    },
  }) as { POST: (req: Record<string, never>) => Promise<{ status: number; body: unknown }> };
  const resendRes = await resend.POST({});
  assert(resendRes.status === 500, "resend-verification.POST returns 500 on thrown string");
  assert(!leaked(JSON.stringify(resendRes), SYN.password), "resend-verification.POST HTTP body has no secrets");

  const allHandlerOut = [...handlerLines, ...handlerSink].join("\n");
  assert(!leaked(allHandlerOut, SYN.password, SYN.token), "handler and Robokassa logs have no synthetic secrets");
  assert(handlerLines.some((line) => line.includes("register")), "register.POST used errorLog");
  assert(handlerLines.some((line) => line.includes("reset-password")), "reset-password.GET used errorLog");
} finally {
  console.error = originalError;
  setDiagnosticSink(null);
}

const authSrc = readFileSync(join(root, "src/lib/auth.ts"), "utf8");
assert(authSrc.includes('withAuthErrorReport("Adapter.linkAccount"'), "auth.ts uses withAuthErrorReport for linkAccount");
assert(authSrc.includes('withAuthErrorReport("Adapter.createUser"'), "auth.ts uses withAuthErrorReport for createUser");
assert(authSrc.includes("logger:"), "NextAuth logger is configured");
assert(authSrc.includes("debug: false"), "NextAuth debug is disabled");
assert(!/console\.error\([^)]*error/.test(authSrc), "auth.ts has no raw console.error of errors");

const prismaSrc = readFileSync(join(root, "src/lib/prisma.js"), "utf8");
assert(prismaSrc.includes("reportPrismaFailure"), "prisma.js uses reportPrismaFailure");
assert(/log:\s*\[\]/.test(prismaSrc), "PrismaClient stdout log is disabled");
assert(!prismaSrc.includes("console.error"), "prisma.js has no console.error");

const registerSrc = readFileSync(join(root, "src/app/api/auth/register/route.ts"), "utf8");
assert(registerSrc.includes('errorLog("Auth", "register", toSafeDiagnostic(error))'), "register.POST catch uses toSafeDiagnostic");
assert(!registerSrc.includes("console.error"), "register route has no console.error");

const resetSrc = readFileSync(join(root, "src/app/api/auth/reset-password/route.ts"), "utf8");
assert(resetSrc.includes("toSafeDiagnostic(error)"), "reset-password catch uses toSafeDiagnostic");
assert(!resetSrc.includes("console.error"), "reset-password route has no console.error");

const forgotSrc = readFileSync(join(root, "src/app/api/auth/forgot-password/route.ts"), "utf8");
assert(forgotSrc.includes("emailDomain(email)"), "forgot-password skip log uses email domain");
assert(!forgotSrc.includes("console.error"), "forgot-password route has no console.error");

const resendSrc = readFileSync(join(root, "src/app/api/auth/resend-verification/route.ts"), "utf8");
assert(resendSrc.includes("toSafeDiagnostic(error)"), "resend-verification catch uses toSafeDiagnostic");
assert(!resendSrc.includes("{ userId: user.id, error }"), "resend-verification does not nest unknown error in context");

const robokassaSrc = readFileSync(join(root, "src/lib/robokassa.ts"), "utf8");
assert(!robokassaSrc.includes("body=${") && !robokassaSrc.includes("responseText"), "Robokassa does not log provider response bodies");

const sitemapSrc = readFileSync(join(root, "src/app/sitemap.ts"), "utf8");
assert(sitemapSrc.includes('errorLog("Sitemap"'), "sitemap Prisma catch uses errorLog");
assert(!sitemapSrc.includes("console.error"), "sitemap has no console.error");

const cronAnon = readFileSync(join(root, "src/app/api/cron/cleanup-anonymous/route.ts"), "utf8");
assert(cronAnon.includes("logCronSecretCheck"), "cleanup-anonymous uses secret inspection");
assert(!cronAnon.includes("maskSecret"), "cleanup-anonymous does not mask secret fragments");

const cronInspect = inspectCronSecrets("SYNTHETIC_CRON_EXPECTED", "SYNTHETIC_CRON_PROVIDED");
const inspectDump = dump(cronInspect);
assert(cronInspect.configured && cronInspect.provided && !cronInspect.matched, "cron inspection reports mismatch without values");
assert(!inspectDump.includes("SYNTHETIC_CRON_EXPECTED") && !inspectDump.includes("SYNTHETIC_CRON_PROVIDED"), "cron inspection dump has no secret values");

console.log("P0 required env");
function withClearedEnv(names: string[], run: () => void) {
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

withClearedEnv(["NEXTAUTH_SECRET", "DATABASE_URL", "DIRECT_URL"], () => {
  for (const name of ["NEXTAUTH_SECRET", "DATABASE_URL"] as const) {
    let message = "";
    try {
      getRequiredEnv(name);
    } catch (error) {
      message = error instanceof Error ? error.message : "non-error";
    }
    assert(message.includes(name), `${name} missing error names the variable`);
    assert(!/postgresql:\/\//i.test(message) && !/secret/i.test(message.split(name).join("")), `${name} missing error has no config values`);
  }
});

console.log("P0 commit-candidate scan");
console.log("  scanner limits: git tracked + untracked/staged text files only; ignored/binary/unknown extensions skipped; heuristics cannot prove absence of all secrets");

type ScanHit = { path: string; line: number; rule: string; status: "fail" | "placeholder_ok" };
const hits: ScanHit[] = [];

const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
  ".sql",
  ".json",
  ".yml",
  ".yaml",
  ".txt",
  ".log",
  ".env",
  ".example",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".xml",
  ".html",
  ".css",
  ".prisma",
  ".properties",
]);

const TEXT_NAMES = new Set(["dockerfile", "makefile", ".gitignore", ".npmrc", ".dockerignore", "procfile"]);

function isTextCandidate(rel: string): boolean {
  const base = (rel.split("/").pop() ?? rel).toLowerCase();
  if (TEXT_NAMES.has(base) || base.startsWith(".env")) return true;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXT.has(base.slice(dot));
}

function classifyScanLine(rel: string, line: string, n: number): ScanHit[] {
  const found: ScanHit[] = [];
  if (/postgresql:\/\/user:pass@host/.test(line) || /sk_test_\.\.\./.test(line)) {
    found.push({ path: rel, line: n, rule: "env-placeholder", status: "placeholder_ok" });
  }
  if (/postgresql:\/\/[^:\s]+:[^@\s]+@/.test(line) && !/postgresql:\/\/user:pass@host/.test(line)) {
    const syntheticLocal =
      /synthetic|p0p1_test_only|127\.0\.0\.1|localhost/i.test(line) &&
      !/newvers|relaxdev|amazonaws|neon\.tech|render\.com/i.test(line);
    found.push({
      path: rel,
      line: n,
      rule: "inline-dsn",
      status: syntheticLocal ? "placeholder_ok" : "fail",
    });
  }
  if (/secret:\s*["'][a-f0-9]{32,}/i.test(line) && !/SYNTHETIC_/i.test(line)) {
    found.push({ path: rel, line: n, rule: "hex-secret-literal", status: "fail" });
  }
  if (/sk_live_[A-Za-z0-9]+/.test(line)) {
    found.push({ path: rel, line: n, rule: "live-stripe-key", status: "fail" });
  }
  return found;
}

const liveKeyMarker = ["sk", "live", "SYNTHETIC_REVIEW_ONLY"].join("_");
const fixtureHits = classifyScanLine(
  "p0-security-review-scan-fixture.json",
  JSON.stringify({ syntheticOnly: true, apiKey: liveKeyMarker }),
  1
);
assert(
  fixtureHits.some((hit) => hit.rule === "live-stripe-key" && hit.status === "fail"),
  "scanner detects synthetic live-key fixture line"
);
const yourAndLive = classifyScanLine("mixed.json", `note=your_example ${liveKeyMarker}`, 1);
assert(
  yourAndLive.some((hit) => hit.rule === "live-stripe-key" && hit.status === "fail"),
  "your_ substring does not skip a live-key match"
);

function gitNul(args: string[]): { ok: boolean; names: string[] } {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    hits.push({ path: `git ${args.join(" ")}`, line: 0, rule: "git-inventory", status: "fail" });
    return { ok: false, names: [] };
  }
  const names = (result.stdout ?? "")
    .split("\0")
    .map((name) => name.trim().replaceAll("\\", "/"))
    .filter(Boolean);
  return { ok: true, names };
}

const tracked = gitNul(["ls-files", "-z"]);
const untracked = gitNul(["ls-files", "-o", "--exclude-standard", "-z"]);
const stagedKeep = gitNul(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]);
const stagedDeleted = gitNul(["diff", "--cached", "--name-only", "-z", "--diff-filter=D"]);
const inventoryOk = tracked.ok && untracked.ok && stagedKeep.ok && stagedDeleted.ok;
assert(inventoryOk, "git commit-candidate inventory succeeded");
assert(readFileSync(join(root, "scripts/verify-p0-security.ts"), "utf8").includes("--diff-filter=ACMR"), "scanner scans staged blobs with ACMR");
assert(readFileSync(join(root, "scripts/verify-p0-security.ts"), "utf8").includes("--diff-filter=D"), "scanner lists staged deletions separately");

const stagedKeepSet = new Set(stagedKeep.names);
const stagedDeletedSet = new Set(stagedDeleted.names);
const trackedSet = new Set(tracked.names);
const candidates = new Set([...tracked.names, ...untracked.names, ...stagedKeep.names]);

function scanText(rel: string, text: string) {
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    hits.push(...classifyScanLine(rel, line, index + 1));
  }
}

function readWorkingTree(rel: string): { ok: true; text: string } | { ok: false } {
  try {
    return { ok: true, text: readFileSync(join(root, rel), "utf8") };
  } catch {
    return { ok: false };
  }
}

for (const rel of candidates) {
  if (!isTextCandidate(rel)) continue;
  const work = readWorkingTree(rel);
  if (work.ok) {
    scanText(rel, work.text);
  } else if (!trackedSet.has(rel) && !stagedKeepSet.has(rel)) {
    hits.push({ path: rel, line: 0, rule: "readable", status: "fail" });
  }
  if (stagedDeletedSet.has(rel)) continue;
  const needsIndex = stagedKeepSet.has(rel) || (!work.ok && trackedSet.has(rel));
  if (!needsIndex) continue;
  const shown = spawnSync("git", ["show", `:${rel}`], { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (shown.status !== 0) {
    hits.push({ path: rel, line: 0, rule: "readable", status: "fail" });
    continue;
  }
  scanText(rel, shown.stdout ?? "");
}

const failedScans = hits.filter((hit) => hit.status === "fail");
for (const hit of hits.filter((item) => item.status === "fail" || item.rule === "env-placeholder").slice(0, 12)) {
  console.log(`  scan ${hit.path}:${hit.line} rule=${hit.rule} status=${hit.status}`);
}
assert(failedScans.length === 0, "commit-candidate scan found no inline DSN or live key literals");

const ignoreEnv = spawnSync("git", ["check-ignore", "-v", ".env", ".env.local", ".env.production"], {
  cwd: root,
  encoding: "utf8",
});
assert(ignoreEnv.status === 0, ".env files are gitignored");

const trackedEnv = spawnSync("git", ["ls-files", ".env", ".env.local", ".env.production"], {
  cwd: root,
  encoding: "utf8",
});
assert((trackedEnv.stdout ?? "").trim() === "", "secret env files are not tracked");

const exampleTracked = spawnSync("git", ["ls-files", ".env.example"], { cwd: root, encoding: "utf8" });
assert((exampleTracked.stdout ?? "").trim() === ".env.example", ".env.example remains tracked");

console.log("");
if (failed > 0) {
  console.error(`Failed ${failed} of ${passed + failed}`);
  process.exit(1);
}
console.log(`Passed ${passed} checks`);
