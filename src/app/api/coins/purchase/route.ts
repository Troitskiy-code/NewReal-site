import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const PACKAGES: Record<number, { vc: number; price: number; label: string }> = {
  1: { vc: 1000, price: 300, label: "1000 VC" },
  2: { vc: 2500, price: 600, label: "2500 VC" },
  3: { vc: 7000, price: 1500, label: "7000 VC" },
  4: { vc: 16000, price: 3000, label: "16000 VC" },
  5: { vc: 35000, price: 6000, label: "35000 VC" },
  6: { vc: 100000, price: 15000, label: "100000 VC" },
};

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const body = await req.json();
    const packageId = Number(body?.packageId);
    const pkg = PACKAGES[packageId];

    if (!pkg) {
      return NextResponse.json({ error: "Неизвестный пакет VC" }, { status: 400 });
    }

    const updatedUser = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        verseCoins: { increment: pkg.vc },
      },
      select: { verseCoins: true },
    });

    await prisma.transaction.create({
      data: {
        userId: session.user.id,
        amount: pkg.vc,
        type: "purchase",
        description: `Покупка ${pkg.label} (${pkg.price} ₽)`,
      },
    });

    return NextResponse.json({
      verseCoins: updatedUser.verseCoins,
      addedVC: pkg.vc,
      message: `На баланс зачислено ${pkg.vc.toLocaleString("ru-RU")} VC`,
    });
  } catch (error) {
    console.error("VC purchase error:", error);
    return NextResponse.json({ error: "Не удалось выполнить покупку" }, { status: 500 });
  }
}
