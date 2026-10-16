import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

// Purpose-separated, short-lived records in NextAuth's existing VerificationToken store.
// Telegram receives only the request key; the independent browser proof never leaves its cookie.
const PREFIX = "tg-web:";
export const WEB_LOGIN_TTL_SECONDS = 5 * 60;
export const WEB_LOGIN_START = "login_";
export const WEB_LOGIN_CONFIRM = "login_ok_";
const KEY = /^[A-Za-z0-9_-]{32}$/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenHash = (key: string) => digest(`${PREFIX}${key}`);
const browserHash = (proof: string) => digest(`tg-browser:${proof}`);

export function webLoginCode(key: string): string {
  return (Number.parseInt(digest(`tg-code:${key}`).slice(0, 8), 16) % 1_000_000).toString().padStart(6, "0");
}

export async function createWebLogin(previous?: string) {
  if (previous) await cancelWebLogin(previous);
  const key = randomBytes(24).toString("base64url");
  const proof = randomBytes(24).toString("base64url");
  const expires = new Date(Date.now() + WEB_LOGIN_TTL_SECONDS * 1000);
  await prisma.verificationToken.create({ data: { token: tokenHash(key), identifier: `${PREFIX}${browserHash(proof)}`, expires } });
  await prisma.verificationToken.deleteMany({ where: { identifier: { startsWith: PREFIX }, expires: { lt: new Date() } } });
  return { key, cookie: `${key}.${proof}`, code: webLoginCode(key), expiresAt: expires.toISOString() };
}

function browserRequest(cookie: string | undefined) {
  const [key, proof, extra] = cookie?.split(".") ?? [];
  if (!KEY.test(key ?? "") || !KEY.test(proof ?? "") || extra !== undefined) return null;
  return { token: tokenHash(key), identifier: `${PREFIX}${browserHash(proof)}` };
}

export async function cancelWebLogin(cookie: string) {
  const request = browserRequest(cookie);
  if (request) await prisma.verificationToken.deleteMany({ where: {
    token: request.token, OR: [{ identifier: request.identifier }, { identifier: { startsWith: `${request.identifier}:` } }],
  } });
}

/** Merely opening a deep link never signs in. Approval is a second action in the bot. */
export async function prepareWebLogin(key: string, telegramId: string) {
  if (!KEY.test(key)) return "invalid" as const;
  const [request, account] = await Promise.all([
    prisma.verificationToken.findUnique({ where: { token: tokenHash(key) } }),
    prisma.telegramAccount.findUnique({ where: { telegramId } }),
  ]);
  if (!request || request.expires <= new Date() || !/^tg-web:[a-f0-9]{64}$/.test(request.identifier)) return "invalid" as const;
  if (!account?.userId) return "no_account" as const;
  return "confirm" as const;
}

export async function approveWebLogin(key: string, telegramId: string) {
  if (await prepareWebLogin(key, telegramId) !== "confirm") return false;
  return prisma.$transaction(async (tx) => {
    const account = await tx.telegramAccount.findUnique({ where: { telegramId } });
    const request = await tx.verificationToken.findUnique({ where: { token: tokenHash(key) } });
    if (!account?.userId || !request || !/^tg-web:[a-f0-9]{64}$/.test(request.identifier)) return false;
    const updated = await tx.verificationToken.updateMany({
      where: { token: request.token, identifier: request.identifier, expires: { gt: new Date() } },
      // Account id is immutable for the lifetime of a link: unlink/relink invalidates this approval.
      data: { identifier: `${request.identifier}:${account.id}` },
    });
    return updated.count === 1;
  });
}

export async function getWebLogin(cookie: string | undefined) {
  const browser = browserRequest(cookie);
  if (!browser) return { status: "expired" as const };
  const request = await prisma.verificationToken.findUnique({ where: { token: browser.token } });
  if (!request || request.expires <= new Date()) return { status: "expired" as const };
  if (request.identifier === browser.identifier) return { status: "pending" as const };
  if (!request.identifier.startsWith(`${browser.identifier}:`)) return { status: "expired" as const };
  const id = request.identifier.slice(browser.identifier.length + 1);
  const account = await prisma.telegramAccount.findUnique({ where: { id }, include: { user: true } });
  if (!account?.userId || !account.user) return { status: "expired" as const };
  return { status: "approved" as const, account, request };
}

/** Atomic consume; a different browser, replay or a rotated/unlinked identity cannot use it. */
export async function consumeWebLogin(cookie: string | undefined) {
  const state = await getWebLogin(cookie);
  if (state.status !== "approved") return null;
  const consumed = await prisma.verificationToken.deleteMany({ where: {
    token: state.request.token, identifier: state.request.identifier, expires: { gt: new Date() },
  } });
  if (consumed.count !== 1) return null;
  const account = await prisma.telegramAccount.findFirst({ where: { id: state.account.id, userId: state.account.userId }, include: { user: true } });
  return account?.user ? account : null;
}
