import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { ONBOARDING_COOKIE, parseOnboardingPrefs, type OnboardingPrefs } from "./onboarding";

/** Off until ONBOARDING_ENABLED=true, so the release and the switch-on are separate steps. */
export const isOnboardingEnabled = () => process.env['ONBOARDING_ENABLED']?.trim() === "true";

/** The picker's answers for this browser; null outside a request or when absent. */
export async function readOnboardingPrefs(): Promise<OnboardingPrefs | null> {
  try {
    return parseOnboardingPrefs((await cookies()).get(ONBOARDING_COOKIE)?.value);
  } catch {
    return null;
  }
}

// Crawlers and link previews keep getting the plain catalog, so the home page stays indexable.
const BOT_AGENT = /bot|crawl|spider|slurp|facebookexternalhit|vkshare|telegram|whatsapp|preview|lighthouse/i;

/** First visit only: no saved answers, not a crawler, and a signed-in viewer has never written a message. */
export async function shouldShowOnboarding(viewerId: string | null, prefs: OnboardingPrefs | null): Promise<boolean> {
  if (!isOnboardingEnabled() || prefs) return false;
  try {
    if (BOT_AGENT.test((await headers()).get("user-agent") ?? "")) return false;
    if (!viewerId) return true;
    const message = await prisma.message.findFirst({ where: { userId: viewerId, role: "user" }, select: { id: true } });
    return !message;
  } catch (error) {
    // Never block the catalog on the picker.
    errorLog("Onboarding", "visibility check", toSafeDiagnostic(error));
    return false;
  }
}
