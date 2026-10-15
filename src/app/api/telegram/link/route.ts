import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { consumeRateLimit } from "@/lib/rateLimit";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { createLinkToken, getTelegramLinkStatus, LINK_START_PREFIX, unlinkTelegram } from "@/lib/telegram/accounts";
import { isTelegramMiniAppEnabled, telegramBotUsername } from "@/lib/telegram/config";
import { isTelegramContext } from "@/lib/telegram/context";
import { isSameOriginRequest, telegramJson } from "@/lib/telegram/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Profile on the website: link status, one-time link (t.me/<bot>?start=link_<token>), unlink.

async function userId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return session?.user?.id ?? null;
}

function failure(error: unknown) {
  if (["P2021", "P2022"].includes((error as { code?: string }).code ?? "")) {
    return telegramJson({ error: "unavailable" }, 503);
  }
  errorLog("Telegram", "link request failed", toSafeDiagnostic(error));
  return telegramJson({ error: "error" }, 500);
}

export async function GET() {
  if (!isTelegramMiniAppEnabled()) return telegramJson({ enabled: false }, 404);
  try {
    const id = await userId();
    if (!id) return telegramJson({ error: "unauthorized" }, 401);
    return telegramJson({ enabled: Boolean(telegramBotUsername()), ...(await getTelegramLinkStatus(id)) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: NextRequest) {
  if (!isTelegramMiniAppEnabled()) return telegramJson({ enabled: false }, 404);
  if (!isSameOriginRequest(req)) return telegramJson({ error: "forbidden" }, 403);
  try {
    const id = await userId();
    if (!id) return telegramJson({ error: "unauthorized" }, 401);
    // Linking starts on the website; inside Telegram the account is already the Telegram one.
    if (await isTelegramContext()) return telegramJson({ error: "telegram_context" }, 409);
    const bot = telegramBotUsername();
    if (!bot) return telegramJson({ error: "unavailable" }, 503);
    const status = await getTelegramLinkStatus(id);
    if (status.linked) return telegramJson({ error: "already_linked" }, 409);
    const limit = await consumeRateLimit(`telegram-link:${id}`, 10, 60 * 60 * 1000);
    if (!limit.ok) return telegramJson({ error: "rate_limited" }, 429);
    const { token, expiresAt } = await createLinkToken(id);
    infoLog("Telegram", "link token created", { userId: id });
    return telegramJson({ url: `https://t.me/${bot}?start=${LINK_START_PREFIX}${token}`, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(req: NextRequest) {
  if (!isTelegramMiniAppEnabled()) return telegramJson({ enabled: false }, 404);
  if (!isSameOriginRequest(req)) return telegramJson({ error: "forbidden" }, 403);
  try {
    const id = await userId();
    if (!id) return telegramJson({ error: "unauthorized" }, 401);
    const result = await unlinkTelegram(id);
    if (result === "only_login_method") return telegramJson({ error: result }, 409);
    if (result === "not_linked") return telegramJson({ error: result }, 404);
    infoLog("Telegram", "unlinked", { userId: id });
    return telegramJson({ ok: true, ...(await getTelegramLinkStatus(id)) });
  } catch (error) {
    return failure(error);
  }
}
