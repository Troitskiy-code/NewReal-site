import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiT } from "@/lib/apiI18n";
import { ensureEmailVerificationTable } from "@/lib/ensureEmailVerification";
import { grantReferralBonusIfEligible } from "@/lib/referralBonus";
import { errorLog, infoLog } from "@/lib/logger";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const token = typeof body?.token === "string" ? body.token.trim() : "";

    if (!token) {
      return NextResponse.json({ error: apiT(req, "api.tokenRequired") }, { status: 400 });
    }

    await ensureEmailVerificationTable();

    const verificationToken = await prisma.emailVerificationToken.findUnique({
      where: { token },
      include: {
        user: {
          select: { id: true, emailVerified: true },
        },
      },
    });

    if (!verificationToken || verificationToken.expiresAt <= new Date()) {
      infoLog("EmailVerification", "Invalid or expired token");
      return NextResponse.json({ error: apiT(req, "api.invalidVerificationLink") }, { status: 400 });
    }

    const verifiedAt = new Date();

    await prisma.$transaction([
      prisma.user.update({
        where: { id: verificationToken.userId },
        data: { emailVerified: verifiedAt },
      }),
      prisma.emailVerificationToken.deleteMany({
        where: { userId: verificationToken.userId },
      }),
    ]);

    try {
      await grantReferralBonusIfEligible(verificationToken.userId);
    } catch (error) {
      errorLog("EmailVerification", "Referral bonus failed after verify", {
        userId: verificationToken.userId,
        error,
      });
    }

    infoLog("EmailVerification", "Email verified", { userId: verificationToken.userId });
    return NextResponse.json({ success: true });
  } catch (error) {
    errorLog("EmailVerification", "Verify failed", error);
    return NextResponse.json({ error: apiT(req, "api.internalError") }, { status: 500 });
  }
}
