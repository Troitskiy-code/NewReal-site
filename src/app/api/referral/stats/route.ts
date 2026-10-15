import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isTelegramContext } from "@/lib/telegram/context";
import { telegramBotUsername } from "@/lib/telegram/config";

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

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    let user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { referralCode: true },
    });

    if (!user) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    if (!user.referralCode) {
      const referralCode = await generateUniqueReferralCode();
      user = await prisma.user.update({
        where: { id: session.user.id },
        data: { referralCode },
        select: { referralCode: true },
      });
    }

    const count = await prisma.user.count({
      where: { referredBy: session.user.id },
    });

    const bot = (await isTelegramContext()) ? telegramBotUsername() : null;
    return NextResponse.json({
      count,
      referralCode: user.referralCode,
      ...(bot ? { telegramReferralUrl: `https://t.me/${bot}?startapp=ref_${user.referralCode}` } : {}),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    errorLog("Server", "Referral stats error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
