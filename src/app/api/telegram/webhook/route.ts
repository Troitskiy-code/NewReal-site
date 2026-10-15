import type { NextRequest } from "next/server";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { handleBotUpdate } from "@/lib/telegram/bot";
import { isTelegramMiniAppEnabled, telegramWebhookSecret } from "@/lib/telegram/config";
import { secretEquals, telegramJson } from "@/lib/telegram/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UPDATE_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  if (!isTelegramMiniAppEnabled()) return telegramJson({ ok: false }, 404);
  // Checked before the body is read: a request without the secret has no side effects.
  if (!secretEquals(telegramWebhookSecret(), req.headers.get("x-telegram-bot-api-secret-token"))) {
    return telegramJson({ ok: false }, 401);
  }
  let update: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_UPDATE_BYTES) return telegramJson({ ok: true });
    update = JSON.parse(raw);
  } catch {
    return telegramJson({ ok: true });
  }
  try {
    const outcome = await handleBotUpdate(update);
    infoLog("TelegramBot", "update", { command: outcome.command, ...(outcome.link ? { link: outcome.link } : {}) });
    // The reply rides on the webhook response; Telegram executes it as a Bot API call.
    return telegramJson(outcome.reply ?? { ok: true });
  } catch (error) {
    errorLog("TelegramBot", "update failed", toSafeDiagnostic(error));
    // 200 so Telegram does not redeliver: a link token is single-use anyway.
    return telegramJson({ ok: true });
  }
}
