import type { NextResponse } from "next/server";
import { encode, type JWT } from "next-auth/jwt";
import { authOptions } from "@/lib/auth";
import { getRequiredEnv } from "@/lib/requireEnv";
import { telegramCookieNames } from "./shared";

// NextAuth's default JWT session lifetime; the Telegram cookie lives exactly as long.
export const TELEGRAM_SESSION_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * A regular NextAuth JWT session for a Telegram launch. The token goes through the same jwt
 * callback as a Credentials sign-in (pending subscription, guest chat claim, registration goal),
 * so getServerSession() and useSession() see an ordinary session.
 */
export async function issueTelegramSessionToken(input: {
  userId: string;
  accountId: string;
  name: string | null;
  createdAt: Date;
  isNew: boolean;
}): Promise<string> {
  const base: JWT = { id: input.userId, sub: input.userId, name: input.name, email: null, picture: null };
  const jwtCallback = authOptions.callbacks?.jwt;
  const token = jwtCallback
    ? await jwtCallback({
        token: base,
        user: { id: input.userId, name: input.name, email: null, createdAt: input.createdAt, emailVerified: null },
        account: { provider: "telegram", type: "credentials", providerAccountId: input.accountId },
        isNewUser: input.isNew,
        trigger: input.isNew ? "signUp" : "signIn",
      })
    : base;
  // Always present, whatever the callback does: unlinking revokes exactly these sessions.
  token.telegramAccountId = input.accountId;
  return encode({ token, secret: getRequiredEnv("NEXTAUTH_SECRET"), maxAge: TELEGRAM_SESSION_MAX_AGE });
}

function cookieOptions(maxAge: number) {
  // Partitioned + SameSite=None: Telegram Web opens the app in a cross-site frame. Only this
  // cookie is relaxed; the site's NextAuth cookie keeps SameSite=Lax.
  return { path: "/", httpOnly: true, secure: true, sameSite: "none" as const, partitioned: true, maxAge };
}

export function setTelegramContextCookie(response: NextResponse): void {
  response.cookies.set(telegramCookieNames().context, "1", cookieOptions(TELEGRAM_SESSION_MAX_AGE));
}

export function setTelegramSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set(telegramCookieNames().session, token, cookieOptions(TELEGRAM_SESSION_MAX_AGE));
}

/** Sign-out inside Telegram: removes the Telegram cookies and the site session cookie of this jar. */
export function clearTelegramCookies(response: NextResponse, { keepContext = false } = {}): void {
  const names = telegramCookieNames();
  response.cookies.set(names.session, "", cookieOptions(0));
  if (!keepContext) response.cookies.set(names.context, "", cookieOptions(0));
  response.cookies.set(names.nextAuthSession, "", { path: "/", httpOnly: true, secure: names.nextAuthSession.startsWith("__Secure-"), sameSite: "lax", maxAge: 0 });
}
