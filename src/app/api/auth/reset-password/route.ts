import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { apiT } from "@/lib/apiI18n";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";

const MIN_PASSWORD_LENGTH = 8;

async function findValidResetToken(token: string) {
  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { token },
    include: {
      user: {
        select: { id: true, password: true },
      },
    },
  });

  if (!resetToken || resetToken.expiresAt <= new Date()) {
    return null;
  }

  if (!resetToken.user?.password) {
    return null;
  }

  return resetToken;
}

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token")?.trim() || "";
    if (!token) {
      return NextResponse.json({ valid: false }, { status: 400 });
    }

    const resetToken = await findValidResetToken(token);
    return NextResponse.json({ valid: Boolean(resetToken) });
  } catch (error) {
    errorLog("Auth", "reset-password.token", toSafeDiagnostic(error));
    return NextResponse.json({ valid: false }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!token || !password) {
      return NextResponse.json(
        { error: apiT(req, "api.tokenPasswordRequired") },
        { status: 400 }
      );
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: apiT(req, "api.minPassword", { count: MIN_PASSWORD_LENGTH }) },
        { status: 400 }
      );
    }

    const resetToken = await findValidResetToken(token);
    if (!resetToken) {
      infoLog("Auth", "reset-password token rejected");
      return NextResponse.json(
        { error: apiT(req, "api.invalidLink"), code: "invalidLink" },
        { status: 400 }
      );
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: resetToken.userId },
        data: { password: hashedPassword },
      }),
      prisma.passwordResetToken.deleteMany({
        where: { userId: resetToken.userId },
      }),
    ]);

    infoLog("Auth", "Password reset successful", { userId: resetToken.userId });
    return NextResponse.json({ success: true });
  } catch (error) {
    errorLog("Auth", "reset-password", toSafeDiagnostic(error));
    return NextResponse.json({ error: apiT(req, "api.internalError") }, { status: 500 });
  }
}
