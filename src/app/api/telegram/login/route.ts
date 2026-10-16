import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { consumeIpRateLimit } from "@/lib/rateLimit";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { isTelegramMiniAppEnabled, telegramBotUsername } from "@/lib/telegram/config";
import { isTelegramContext } from "@/lib/telegram/context";
import { isSameOriginRequest, readLimitedJson, telegramJson } from "@/lib/telegram/http";
import { issueTelegramSessionToken, TELEGRAM_SESSION_MAX_AGE } from "@/lib/telegram/session";
import { secureTelegramCookies, telegramCookieNames } from "@/lib/telegram/shared";
import { cancelWebLogin, consumeWebLogin, createWebLogin, getWebLogin, WEB_LOGIN_START, WEB_LOGIN_TTL_SECONDS } from "@/lib/telegram/webLogin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const cookieName = () => secureTelegramCookies() ? "__Host-nv-tg-login" : "nv-tg-login";
const cookieOptions = (maxAge: number) => ({ path: "/", httpOnly: true, secure: secureTelegramCookies(), sameSite: "strict" as const, maxAge });

function failure(error: unknown) {
  errorLog("Telegram", "website login failed", toSafeDiagnostic(error));
  return telegramJson({ error: "unavailable" }, 503);
}

export async function GET(req: NextRequest) {
  if (!isTelegramMiniAppEnabled()) return telegramJson({ enabled: false }, 404);
  if (!isSameOriginRequest(req)) return telegramJson({ error: "forbidden" }, 403);
  try {
    const state = await getWebLogin(req.cookies.get(cookieName())?.value);
    return telegramJson({ status: state.status, ...(state.status === "approved" ? { name: state.account.user?.name || "NewVerse" } : {}) });
  } catch (error) { return failure(error); }
}

export async function POST(req: NextRequest) {
  if (!isTelegramMiniAppEnabled()) return telegramJson({ enabled: false }, 404);
  if (!isSameOriginRequest(req)) return telegramJson({ error: "forbidden" }, 403);
  try {
    if (await isTelegramContext()) return telegramJson({ error: "telegram_context" }, 409);
    // Account changes require a deliberate sign-out first.
    if ((await getServerSession(authOptions))?.user?.id) return telegramJson({ error: "already_signed_in" }, 409);
    const body = await readLimitedJson(req, 256) as { action?: unknown };
    const cookie = req.cookies.get(cookieName())?.value;
    if (body?.action === "create") {
      const bot = telegramBotUsername();
      if (!bot) return telegramJson({ error: "unavailable" }, 503);
      const limit = await consumeIpRateLimit(req, "telegram-web-login", { limit: 15, sharedLimit: 300, windowMs: 15 * 60_000 });
      if (!limit.ok) return telegramJson({ error: "rate_limited" }, 429);
      const request = await createWebLogin(cookie);
      const response = telegramJson({ url: `https://t.me/${bot}?start=${WEB_LOGIN_START}${request.key}`, code: request.code, expiresAt: request.expiresAt });
      response.cookies.set(cookieName(), request.cookie, cookieOptions(WEB_LOGIN_TTL_SECONDS));
      return response;
    }
    if (body?.action !== "complete") return telegramJson({ error: "invalid" }, 400);
    const account = await consumeWebLogin(cookie);
    if (!account?.user) return telegramJson({ error: "expired" }, 401);
    const token = await issueTelegramSessionToken({ userId: account.user.id, accountId: account.id,
      name: account.user.name, email: account.user.email, emailVerified: account.user.emailVerified,
      createdAt: account.user.createdAt, isNew: false });
    const response = telegramJson({ status: "ok" });
    response.cookies.set(telegramCookieNames().nextAuthSession, token, {
      path: "/", httpOnly: true, secure: secureTelegramCookies(), sameSite: "lax", maxAge: TELEGRAM_SESSION_MAX_AGE,
    });
    response.cookies.set(cookieName(), "", cookieOptions(0));
    return response;
  } catch (error) {
    if ([400, 413].includes((error as { status?: number }).status ?? 0)) return telegramJson({ error: "invalid" }, 400);
    return failure(error);
  }
}

export async function DELETE(req: NextRequest) {
  if (!isSameOriginRequest(req)) return telegramJson({ error: "forbidden" }, 403);
  try {
    await cancelWebLogin(req.cookies.get(cookieName())?.value ?? "");
    const response = telegramJson({ status: "ok" });
    response.cookies.set(cookieName(), "", cookieOptions(0));
    return response;
  } catch (error) { return failure(error); }
}
