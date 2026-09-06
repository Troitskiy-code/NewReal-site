import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { buildReceipt, generateRobokassaPaymentUrl } from "@/lib/robokassa";
import { getVcPackage } from "@/lib/vcPackages";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const body = await req.json();
    const desc = typeof body?.desc === "string" ? body.desc : "";
    const packageId = Number(body?.packageId);
    const pkg = Number.isFinite(packageId) ? getVcPackage(packageId) : undefined;

    // Robokassa accepts RUB only. Ignore any client-sent converted amount.
    if (!pkg) {
      return NextResponse.json({ error: "Неизвестный пакет VC" }, { status: 400 });
    }

    const amount = pkg.price;
    const description = desc || `Покупка ${pkg.label}`;
    console.log("[Payment] Creating VC payment in RUB:", { packageId: pkg.id, vc: pkg.vc, amount });
    const receipt = buildReceipt([{ name: "Пополнение VerseCoins", price: amount, quantity: 1 }]);
    const url = generateRobokassaPaymentUrl(session.user.id, amount, description, {}, receipt);
    return NextResponse.json({ url });
  } catch (error) {
    console.error("Payment creation error:", error);
    return NextResponse.json({ error: "Ошибка создания платежа" }, { status: 500 });
  }
}
