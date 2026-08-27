import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { buildReceipt, generateRobokassaPaymentUrl } from "@/lib/robokassa";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { sum, desc } = await req.json();

    if (!sum || !desc) {
      return NextResponse.json({ error: "sum и desc обязательны" }, { status: 400 });
    }

    const amount = Number(sum);
    const receipt = buildReceipt([{ name: "Пополнение VerseCoins", price: amount }]);
    const url = generateRobokassaPaymentUrl(session.user.id, amount, String(desc), {}, receipt);
    return NextResponse.json({ url });
  } catch (error) {
    console.error("Payment creation error:", error);
    return NextResponse.json({ error: "Ошибка создания платежа" }, { status: 500 });
  }
}
