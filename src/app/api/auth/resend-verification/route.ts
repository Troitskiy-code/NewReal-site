import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiT, getApiLocale } from "@/lib/apiI18n";
import { createAndSendVerificationEmail, isEmailVerified } from "@/lib/emailVerification";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { consumeRateLimit, retryAfterSeconds } from "@/lib/rateLimit";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: apiT(req, "api.unauthorized") }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        email: true,
        emailVerified: true,
        createdAt: true,
        accounts: { select: { provider: true } },
      },
    });

    if (!user?.email) {
      return NextResponse.json({ error: apiT(req, "api.userNotFound") }, { status: 404 });
    }

    if (isEmailVerified(user)) {
      return NextResponse.json({ error: apiT(req, "api.emailAlreadyVerified") }, { status: 400 });
    }

    const limited = await consumeRateLimit(`resend-verification:user:${user.id}`, 3, 60 * 60 * 1000);
    if (!limited.ok) {
      return NextResponse.json(
        { error: apiT(req, "api.rateLimited") },
        { status: 429, headers: { "Retry-After": retryAfterSeconds(limited) } }
      );
    }

    try {
      await createAndSendVerificationEmail(
        user.id,
        user.email,
        getApiLocale(req),
        "EmailVerification:Resend"
      );
    } catch (error) {
      errorLog("EmailVerification:Resend", "Failed to send email", { userId: user.id }, toSafeDiagnostic(error));
      return NextResponse.json({ error: apiT(req, "api.internalError") }, { status: 500 });
    }

    infoLog("EmailVerification:Resend", "Verification email resent", { userId: user.id });
    return NextResponse.json({ success: true });
  } catch (error) {
    errorLog("EmailVerification:Resend", "POST failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: apiT(req, "api.internalError") }, { status: 500 });
  }
}
