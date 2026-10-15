import { cookies, headers } from "next/headers";
import { TELEGRAM_CONTEXT_COOKIE, TELEGRAM_CONTEXT_HEADER } from "./shared";

/**
 * Telegram context of the current request: the httpOnly context cookie set by a verified launch,
 * or the proxy header of the /tg entry page. Client-side window.Telegram is never used for this.
 * Both cookie names are accepted, so a wrong NEXTAUTH_URL scheme cannot reveal purchases.
 */
export async function isTelegramContext(): Promise<boolean> {
  try {
    const jar = await cookies();
    if (jar.get(TELEGRAM_CONTEXT_COOKIE.secure)?.value || jar.get(TELEGRAM_CONTEXT_COOKIE.plain)?.value) return true;
    return (await headers()).get(TELEGRAM_CONTEXT_HEADER) === "1";
  } catch {
    // Outside a request scope (scripts, background work): never the Telegram context.
    return false;
  }
}

export const TELEGRAM_BALANCE_EXHAUSTED = { ru: "Баланс VC исчерпан", en: "Your VC balance is used up" } as const;

/** Error text for a missing VC balance: neutral in Telegram (no price, no purchase hint). */
export async function insufficientBalanceMessage(fallback: string): Promise<string> {
  return (await isTelegramContext()) ? TELEGRAM_BALANCE_EXHAUSTED.ru : fallback;
}
