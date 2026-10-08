import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { grantPermanentUpdate } from "@/lib/verseCoins";
import crypto from "crypto";

export async function GET(req: NextRequest) {
  const secretKey = process.env['UNITPAY_SECRET_KEY']?.trim();
  if (!secretKey) {
    return NextResponse.json({ error: "Unitpay is not configured" }, { status: 503 });
  }
  try {
    const searchParams = req.nextUrl.searchParams;
    const method = searchParams.get("method");
    const account = searchParams.get("account");
    const sum = searchParams.get("sum");
    const currency = searchParams.get("currency") || "RUB";
    const signature = searchParams.get("signature");

    const paramsForSignature = { account, currency, sum };
    const sortedKeys = Object.keys(paramsForSignature).sort();
    let signatureString = sortedKeys
      .map((key) => paramsForSignature[key as keyof typeof paramsForSignature])
      .join("{up}");
    signatureString += `{up}${secretKey}`;
    const hash = crypto.createHash("sha256").update(signatureString).digest("hex");

    if (hash !== signature) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }

    if (method === "CHECK") {
      const user = await prisma.user.findUnique({
        where: { id: account },
      });
      if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
      return NextResponse.json({ status: "success" });
    }

    if (method === "PAY") {
      const vcAmount = Math.round(Number(sum) / 0.3);
      await prisma.$transaction([
        prisma.user.update({
          where: { id: account },
          data: grantPermanentUpdate(vcAmount),
        }),
        prisma.transaction.create({
          data: {
            userId: account,
            amount: vcAmount,
            type: "purchase",
            description: `Пополнение VC на ${sum} ₽`,
          },
        }),
      ]);
      return NextResponse.json({ status: "success" });
    }

    return NextResponse.json({ status: "ignored" });
  } catch (error) {
    errorLog("Server", "Unitpay webhook error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
