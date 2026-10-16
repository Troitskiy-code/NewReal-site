import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { consumeIpRateLimit, retryAfterSeconds } from "@/lib/rateLimit";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { isLocale, LOCALE_COOKIE, type Locale } from "@/lib/i18nConfig";
import { verifyInitData } from "@/lib/telegram/initData";
import { isTelegramMiniAppEnabled, telegramBotToken, telegramInitDataMaxAgeSeconds } from "@/lib/telegram/config";
import { consumeInitDataReceipt, resolveTelegramUser, telegramAccountState } from "@/lib/telegram/accounts";
import { clearTelegramCookies, issueTelegramSessionToken, setTelegramContextCookie, setTelegramSessionCookie } from "@/lib/telegram/session";
import { isSameOriginRequest, readLimitedJson, telegramJson } from "@/lib/telegram/http";
import { normalizeTelegramReferralCode, parseTelegramStartParam, telegramReferralFromStartParam } from "@/lib/telegram/shared";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Signed initData -> ordinary NextAuth session. The request body (initData) is never logged.

function targetPath(locale: Locale, startParam: string | null): string {
  const { characterSlug } = parseTelegramStartParam(startParam);
  return characterSlug ? `/${locale}/character/${characterSlug}` : `/${locale}`;
}

function requestLocale(req: NextRequest, languageCode: string | null): Locale {
  // The language switcher's choice wins; otherwise Telegram's language (ru -> RU, else EN).
  const saved = req.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(saved)) return saved;
  return languageCode?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export async function POST(req: NextRequest) {
  if (!isTelegramMiniAppEnabled()) return telegramJson({ status: "disabled" }, 404);
  const botToken = telegramBotToken();
  if (!botToken) return telegramJson({ status: "unavailable" }, 503);
  if (!isSameOriginRequest(req) || !req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return telegramJson({ status: "forbidden" }, 403);
  }

  try {
    const limit = await consumeIpRateLimit(req, "telegram-auth", { limit: 60, sharedLimit: 3000, windowMs: 15 * 60 * 1000 });
    if (!limit.ok) {
      const response = telegramJson({ status: "rate_limited" }, 429);
      response.headers.set("Retry-After", retryAfterSeconds(limit));
      return response;
    }

    const body = await readLimitedJson(req, 8192) as { initData?: unknown; consent?: unknown; referralCode?: unknown } | null;
    const maxAgeSeconds = telegramInitDataMaxAgeSeconds();
    const strict = verifyInitData(body?.initData, botToken, { maxAgeSeconds });
    // A valid signature with an old auth_date is still this Telegram user: used only for the
    // "already signed in" check below, never to issue a session.
    const signed = !("reason" in strict) || strict.reason !== "expired" ? strict : verifyInitData(body?.initData, botToken, { maxAgeSeconds: 10 * 365 * 86400 });
    if (!signed.ok) {
      infoLog("Telegram", "launch rejected", { reason: "reason" in signed ? signed.reason : "unknown" });
      return telegramJson({ status: "invalid" }, 401);
    }

    const locale = requestLocale(req, signed.user.languageCode);
    const redirect = targetPath(locale, signed.startParam);
    const account = await telegramAccountState(signed.user.id);

    // Reload of the entry page with the same launch: the session already belongs to this user.
    const current = await getServerSession(authOptions).catch(() => null);
    if (account.state === "linked" && current?.user?.id === account.userId) {
      const response = telegramJson({ status: "ok", redirect, isNew: false });
      setTelegramContextCookie(response);
      return response;
    }

    if (!strict.ok) {
      const response = telegramJson({ status: "expired" }, 401);
      setTelegramContextCookie(response);
      return response;
    }

    const consent = body?.consent === true;
    if (account.state !== "linked") {
      if (account.state === "unlinked") {
        const response = telegramJson({ status: "login_disabled" }, 403);
        setTelegramContextCookie(response);
        clearTelegramCookies(response, { keepContext: true });
        return response;
      }
      if (!consent) {
        const response = telegramJson({ status: "consent_required", locale });
        setTelegramContextCookie(response);
        return response;
      }
    }

    if (!(await consumeInitDataReceipt(strict.replayKey, maxAgeSeconds))) {
      infoLog("Telegram", "launch rejected", { reason: "replay" });
      const response = telegramJson({ status: "replay" }, 401);
      setTelegramContextCookie(response);
      return response;
    }

    const referralCode = telegramReferralFromStartParam(strict.startParam) ?? normalizeTelegramReferralCode(body?.referralCode);
    const result = await resolveTelegramUser(strict.user, { consent, referralCode });
    if (result.status !== "ok") {
      const response = telegramJson({ status: result.status }, result.status === "login_disabled" ? 403 : 200);
      setTelegramContextCookie(response);
      return response;
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId }, select: { name: true, email: true, emailVerified: true } });
    const token = await issueTelegramSessionToken({
      userId: result.userId, accountId: result.accountId, name: user.name, email: user.email, emailVerified: user.emailVerified,
      createdAt: result.createdAt, isNew: result.isNew,
    });
    const response = telegramJson({ status: "ok", redirect, isNew: result.isNew });
    setTelegramContextCookie(response);
    setTelegramSessionCookie(response, token);
    infoLog("Telegram", "session issued", { userId: result.userId, isNew: result.isNew });
    return response;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 400 || status === 413) return telegramJson({ status: "invalid" }, status);
    errorLog("Telegram", "auth failed", toSafeDiagnostic(error));
    return telegramJson({ status: "error" }, 500);
  }
}

/** Sign-out inside Telegram. The context cookie stays, so purchases remain hidden in this app. */
export async function DELETE(req: NextRequest) {
  if (!isSameOriginRequest(req)) return telegramJson({ status: "forbidden" }, 403);
  const response = telegramJson({ status: "ok" });
  clearTelegramCookies(response, { keepContext: true });
  return response;
}
