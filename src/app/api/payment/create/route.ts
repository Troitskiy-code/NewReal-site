import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { buildReceipt, generateRobokassaPaymentUrl } from "@/lib/robokassa";
import { convertPaymentAmount, PREFERRED_CURRENCY_KEY, resolveCurrency } from "@/lib/currency";
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
    const currency = resolveCurrency(body?.currency, req.cookies.get(PREFERRED_CURRENCY_KEY)?.value);

    if (!pkg) {
      return NextResponse.json({ error: "Неизвестный пакет VC" }, { status: 400 });
    }

    const amount = convertPaymentAmount(pkg.price, currency);
    const description = desc || `Покупка ${pkg.label}`;
    console.log("[Payment] Creating VC payment:", {
      packageId: pkg.id,
      vc: pkg.vc,
      amount,
      currency,
      priceRUB: pkg.price,
    });
    const receipt = buildReceipt([{ name: "Пополнение VerseCoins", price: amount, quantity: 1 }]);
    const url = generateRobokassaPaymentUrl(
      session.user.id,
      amount,
      description,
      {},
      receipt,
      undefined,
      currency
    );
    return NextResponse.json({ url });
  } catch (error) {
    console.error("Payment creation error:", error);
    return NextResponse.json({ error: "Ошибка создания платежа" }, { status: 500 });
  }
}
