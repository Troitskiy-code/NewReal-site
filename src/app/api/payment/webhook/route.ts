import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extractShpParams, verifyRobokassaResultSignature } from "@/lib/robokassa";

function firstParam(
  source: { get(name: string): string | File | null },
  ...names: string[]
): string {
  for (const name of names) {
    const value = source.get(name);
    if (value !== null && value !== undefined && String(value) !== "") {
      return String(value);
    }
  }
  return "";
}

function shpValue(shp: Record<string, string>, name: string): string {
  const target = name.toLowerCase();
  const match = Object.entries(shp).find(([key]) => key.toLowerCase() === target);
  return match?.[1] ?? "";
}

async function parseWebhookPayload(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const queryOutSum = firstParam(params, "OutSum", "out_summ", "outsum");
  const queryInvId = firstParam(params, "InvId", "inv_id", "invid");
  const querySignature = firstParam(params, "SignatureValue", "crc", "signaturevalue");
  const queryShp = extractShpParams(params.entries());

  if (queryOutSum && queryInvId && querySignature) {
    return {
      outSum: queryOutSum,
      invId: queryInvId,
      signature: querySignature,
      shp: queryShp,
    };
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const body = await req.formData();
    return {
      outSum: firstParam(body, "OutSum", "out_summ", "outsum"),
      invId: firstParam(body, "InvId", "inv_id", "invid"),
      signature: firstParam(body, "SignatureValue", "crc", "signaturevalue"),
      shp: extractShpParams(body.entries()),
    };
  }

  return {
    outSum: queryOutSum,
    invId: queryInvId,
    signature: querySignature,
    shp: queryShp,
  };
}

function okResponse(invId: string) {
  return new NextResponse(`OK${invId}`, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function handleWebhook(req: NextRequest) {
  const { outSum, invId, signature, shp } = await parseWebhookPayload(req);
  const userId = shpValue(shp, "Shp_userId");

  if (!outSum || !invId || !signature || !userId) {
    console.error("[Robokassa] Webhook error: Missing required fields");
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  if (!verifyRobokassaResultSignature(outSum, invId, signature, shp)) {
    console.error("[Robokassa] Webhook error: Invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  const paymentMarker = `Robokassa InvId=${invId}`;
  const existingPayment = await prisma.transaction.findFirst({
    where: {
      userId,
      description: paymentMarker,
    },
    select: { id: true },
  });

  if (existingPayment) {
    console.log(`[Robokassa] Webhook processed successfully: InvId=${invId}`);
    return okResponse(invId);
  }

  const vcFromShp = Number(shpValue(shp, "Shp_vc"));
  const vcAmount = Number.isFinite(vcFromShp) && vcFromShp > 0
    ? vcFromShp
    : Math.round(Number(outSum) / 0.3);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { verseCoins: { increment: vcAmount } },
    }),
    prisma.transaction.create({
      data: {
        userId,
        amount: vcAmount,
        type: "purchase",
        description: paymentMarker,
      },
    }),
  ]);

  console.log(`[Robokassa] Webhook processed successfully: InvId=${invId}, vcAmount=${vcAmount}`);
  return okResponse(invId);
}

export async function POST(req: NextRequest) {
  try {
    return await handleWebhook(req);
  } catch (error) {
    console.error("[Robokassa] Webhook error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    return await handleWebhook(req);
  } catch (error) {
    console.error("[Robokassa] Webhook error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
