import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { grantPermanentUpdate } from "@/lib/verseCoins";
import { convertPaymentAmount, formatPrice, PREFERRED_CURRENCY_KEY, resolveCurrency } from "@/lib/currency";
import { getCurrencyRates } from "@/lib/currencyRates";
import { getVcPackage } from "@/lib/vcPackages";
import { rejectUnverifiedEmail } from "@/lib/emailVerification";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const unverified = await rejectUnverifiedEmail(req, session.user.id, "api.confirmEmailToPurchase");
    if (unverified) return unverified;

    const body = await req.json();
    const packageId = Number(body?.packageId);
    const pkg = getVcPackage(packageId);
    const currency = resolveCurrency(body?.currency, req.cookies.get(PREFERRED_CURRENCY_KEY)?.value);

    if (!pkg) {
      return NextResponse.json({ error: "Неизвестный пакет VC" }, { status: 400 });
    }

    const rates = await getCurrencyRates();
    const amount = convertPaymentAmount(pkg.price, currency, rates);

    const updatedUser = await prisma.user.update({
      where: { id: session.user.id },
      data: grantPermanentUpdate(pkg.vc),
      select: { verseCoins: true },
    });

    await prisma.transaction.create({
      data: {
        userId: session.user.id,
        amount: pkg.vc,
        type: "purchase",
        description: `Покупка ${pkg.label} (${formatPrice(amount, currency)})`,
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
