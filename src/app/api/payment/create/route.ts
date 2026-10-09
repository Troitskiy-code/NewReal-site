import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { buildReceipt, buildRobokassaSuccessUrl, createRobokassaCheckout } from "@/lib/robokassa";
import { FIRST_VC_PACKAGE, getVcPackage } from "@/lib/vcPackages";
import { reserveFirstVcCheckout } from "@/lib/firstVcPurchase";
import { coinsCharacterId } from "@/lib/coinsReturn";
import { rejectUnverifiedEmail } from "@/lib/emailVerification";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { reportPaymentFailure } from "@/lib/safeDiagnostics";
import { registerPaymentOrder } from "@/lib/paymentOrders";

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
    const pkg = Number.isFinite(packageId) ? getVcPackage(packageId) : undefined;

    if (!pkg) {
      return NextResponse.json({ error: "Неизвестный пакет VC" }, { status: 400 });
    }

    const amount = Number(pkg.price);
    // Never derive a grant from client-controlled description/price/VC fields.
    const description = `Покупка ${pkg.label}`;
    console.log("[Payment] Creating VC payment:", {
      packageId: pkg.id,
      vc: pkg.vc,
      amount,
      currency: "RUB",
      priceRUB: pkg.price,
    });
    const locale = await getRequestLocale();
    const characterId = coinsCharacterId(body?.characterId);
    const successUrl2 = buildRobokassaSuccessUrl("/coins", locale, {
      payment: "success",
      type: "vc",
      ...(characterId ? { characterId } : {}),
    });
    const receipt = buildReceipt([{ name: "Пополнение VerseCoins", price: amount, quantity: 1 }]);
    const buildCheckout = (invoiceId?: string) => createRobokassaCheckout({
      invoiceId,
      userId: session.user.id,
      sum: amount,
      desc: description,
      extraShp: { Shp_type: "vc", Shp_vc: String(pkg.vc), Shp_packageId: String(pkg.id),
        ...(pkg.id === FIRST_VC_PACKAGE.id ? { Shp_offer: "first" } : {}) },
      receipt,
      successUrl2,
      email: session.user.email,
      locale,
    });
    const checkout = pkg.id === FIRST_VC_PACKAGE.id
      ? await reserveFirstVcCheckout(session.user.id, buildCheckout, (reserved, tx) => registerPaymentOrder({
        invoiceId: reserved.fields.InvId, userId: session.user.id, kind: "purchase", amountRub: amount,
        packageId: pkg.id, attribution: body?.attribution, reuseInvoice: true }, tx)) : buildCheckout();
    if (!checkout) return NextResponse.json({ error: "Первый пакет доступен только один раз до первой покупки", code: "FIRST_PACK_UNAVAILABLE" }, { status: 409 });
    if (pkg.id !== FIRST_VC_PACKAGE.id) await registerPaymentOrder({ invoiceId: checkout.fields.InvId, userId: session.user.id,
      kind: "purchase", amountRub: amount, packageId: pkg.id, attribution: body?.attribution });
    return NextResponse.json(checkout);
  } catch (error) {
    reportPaymentFailure("create", error);
    return NextResponse.json({ error: "Ошибка создания платежа" }, { status: 500 });
  }
}
