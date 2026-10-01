import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendResetPasswordEmail } from "@/lib/email";
import { apiT, getApiLocale } from "@/lib/apiI18n";
import { isLocale } from "@/lib/i18nConfig";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { emailDomain } from "@/lib/redactSensitive";

function success() {
  return NextResponse.json({ success: true });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const email = typeof body?.email === "string" ? body.email.trim() : "";

    if (!email) {
      return NextResponse.json({ error: apiT(req, "api.emailRequired") }, { status: 400 });
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, email: true, password: true },
    });

    if (!user || !user.password) {
      infoLog("Auth", "Skipping reset email", {
        domain: emailDomain(email),
        found: Boolean(user),
        hasPassword: Boolean(user?.password),
      });
      return success();
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await prisma.$transaction([
      prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
      prisma.passwordResetToken.create({
        data: {
          token,
          userId: user.id,
          expiresAt,
        },
      }),
    ]);

    infoLog("Auth", "Reset token created", {
      userId: user.id,
      expiresAt: expiresAt.toISOString(),
    });

    try {
      await sendResetPasswordEmail(
        user.email || email,
        token,
        isLocale(body?.locale) ? body.locale : getApiLocale(req)
      );
      infoLog("Auth", "Reset email sent", { userId: user.id });
    } catch (error) {
      errorLog("Auth", "forgot-password.send", { userId: user.id }, toSafeDiagnostic(error));
    }

    return success();
  } catch (error) {
    errorLog("Auth", "forgot-password", toSafeDiagnostic(error));
    return NextResponse.json({ error: apiT(req, "api.internalError") }, { status: 500 });
  }
}
