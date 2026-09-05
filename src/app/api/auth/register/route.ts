import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { apiT } from "@/lib/apiI18n";

const REFERRAL_BONUS = 100;

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
    const { name, email, password, ref } = await req.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: apiT(req, "api.emailPasswordRequired") },
        { status: 400 }
      );
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

    const user = await prisma.user.create({
      data: {
        name: name || "",
        email,
        password: hashedPassword,
        referralCode,
        referredBy,
      },
    });

    if (referredBy) {
      await prisma.user.update({
        where: { id: referredBy },
        data: { realCoins: { increment: REFERRAL_BONUS } },
      });
    }

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
