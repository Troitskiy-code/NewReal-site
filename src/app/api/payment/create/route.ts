import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import crypto from "crypto";

const PUBLIC_KEY = process.env.UNITPAY_PUBLIC_KEY!;
const SECRET_KEY = process.env.UNITPAY_SECRET_KEY!;

function generatePaymentUrl(userId: string, sum: number, desc: string) {
  const currency = "RUB";
  const params = { account: userId, currency, desc, sum };
  const sortedKeys = Object.keys(params).sort();
  let signatureString = sortedKeys
    .map((key) => params[key as keyof typeof params])
    .join("{up}");
  signatureString += `{up}${SECRET_KEY}`;
  const signature = crypto.createHash("sha256").update(signatureString).digest("hex");

  const testParam = SECRET_KEY.includes("test") ? "&test=1" : "";
  return `https://unitpay.ru/pay/${PUBLIC_KEY}?sum=${sum}&account=${userId}&desc=${encodeURIComponent(desc)}&signature=${signature}&currency=${currency}${testParam}`;
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { sum, desc } = await req.json();
    const url = generatePaymentUrl(session.user.id, sum, desc);
    return NextResponse.json({ url });
  } catch (error) {
    console.error("Payment creation error:", error);
    return NextResponse.json({ error: "Ошибка создания платежа" }, { status: 500 });
  }
}
