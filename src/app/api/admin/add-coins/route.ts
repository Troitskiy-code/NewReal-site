import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { grantPermanentUpdate } from "@/lib/verseCoins";

function isAuthorized(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return false;
  }

  const authHeader = req.headers.get("Authorization");
  return authHeader === `Bearer ${adminSecret}`;
}

export async function POST(req: NextRequest) {
  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    const body = await req.json();
    const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const amount = Number(body?.amount);

    if (!userId && !email) {
      return NextResponse.json(
        { error: "Укажите userId или email" },
        { status: 400 }
      );
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      return NextResponse.json(
        { error: "amount должен быть положительным целым числом" },
        { status: 400 }
      );
    }

    const user = userId
      ? await prisma.user.findUnique({ where: { id: userId } })
      : await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    const updatedUser = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: user.id },
        data: grantPermanentUpdate(amount),
        select: { id: true, email: true, verseCoins: true, permanentCoins: true },
      });

      await tx.transaction.create({
        data: {
          userId: user.id,
          amount,
          type: "admin_gift",
          description: `Начисление разработчиком: +${amount} VC`,
        },
      });

      return updated;
    });

    console.log(`🪙 Admin gift: +${amount} VC для user=${updatedUser.id}`);

    return NextResponse.json({
      userId: updatedUser.id,
      email: updatedUser.email,
      addedVC: amount,
      verseCoins: updatedUser.verseCoins,
    });
  } catch (error) {
    console.error("Admin add-coins error:", error);
    return NextResponse.json({ error: "Ошибка начисления VC" }, { status: 500 });
  }
}
