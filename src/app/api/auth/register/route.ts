import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { apiT, getApiLocale } from "@/lib/apiI18n";
import { ensureUserConsentColumns, isAcceptedFlag } from "@/lib/ensureUserConsent";
import { applySignupBenefits } from "@/lib/provisionNewUser";
import { createAndSendVerificationEmail } from "@/lib/emailVerification";
import { errorLog, infoLog } from "@/lib/logger";

async function generateUniqueReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const existing = await prisma.user.findUnique({
      where: { referralCode: code },
      select: { id: true },
    });
    if (!existing) return code;
  }
  throw new Error("Не удалось сгенерировать уникальный реферальный код");
}

export async function POST(req: NextRequest) {
  try {
    const { name, email, password, ref, acceptedTerms, acceptedOffer } = await req.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: apiT(req, "api.emailPasswordRequired") },
        { status: 400 }
      );
    }

    if (!isAcceptedFlag(acceptedTerms) || !isAcceptedFlag(acceptedOffer)) {
      return NextResponse.json({ error: apiT(req, "api.consentRequired") }, { status: 400 });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: apiT(req, "api.userExists") },
        { status: 400 }
      );
    }

    let referredBy: string | null = null;
    if (ref && typeof ref === "string" && ref.trim()) {
      const referrer = await prisma.user.findUnique({
        where: { referralCode: ref.trim().toUpperCase() },
        select: { id: true },
      });
      if (referrer) {
        referredBy = referrer.id;
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const referralCode = await generateUniqueReferralCode();
    const acceptedAt = new Date();

    try {
      await ensureUserConsentColumns();
    } catch (error) {
      console.error("[Consent] Could not ensure User consent columns", error);
    }

    const user = await prisma.user.create({
      data: {
        name: name || "",
        email,
        password: hashedPassword,
        referralCode,
        referredBy,
        acceptedTermsAt: acceptedAt,
        acceptedPrivacyAt: acceptedAt,
      },
    });

    try {
      await applySignupBenefits(user.id);
    } catch (error) {
      console.error("[Signup] Failed to grant start plan / VC", error);
    }

    console.log("[Consent] register", {
      userId: user.id,
      acceptedTermsAt: acceptedAt.toISOString(),
      acceptedPrivacyAt: acceptedAt.toISOString(),
    });

    try {
      await createAndSendVerificationEmail(user.id, email, getApiLocale(req));
    } catch (error) {
      errorLog("EmailVerification", "Register email failed", { userId: user.id, error });
    }

    infoLog("EmailVerification", "Credentials user registered", { userId: user.id });

    return NextResponse.json(
      { message: "Пользователь создан", userId: user.id },
      { status: 201 }
    );
  } catch (error) {
    console.error("Ошибка регистрации:", error);
    return NextResponse.json(
      { error: apiT(req, "api.internalError") },
      { status: 500 }
    );
  }
}
