import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extractShpParams, verifyRobokassaResultSignature } from "@/lib/robokassa";

async function parseWebhookPayload(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const body = await req.formData();
    return {
      outSum: String(body.get("OutSum") ?? ""),
      invId: String(body.get("InvId") ?? ""),
      signature: String(body.get("SignatureValue") ?? ""),
      shp: extractShpParams(body.entries()),
    };
  }

  const params = req.nextUrl.searchParams;
  return {
    outSum: params.get("OutSum") ?? "",
    invId: params.get("InvId") ?? "",
    signature: params.get("SignatureValue") ?? "",
    shp: extractShpParams(params.entries()),
  };
}

async function handleWebhook(req: NextRequest) {
  try {
    const { outSum, invId, signature, shp } = await parseWebhookPayload(req);
    console.log("[Robokassa] webhook params:", { outSum, invId, signature, shp });

    const userId = shp.Shp_userId;

    if (!outSum || !invId || !signature || !userId) {
      console.error("[Robokassa] webhook missing required fields", {
        outSum,
        invId,
        signature,
        userId,
        shp,
      });
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const isValid = verifyRobokassaResultSignature(outSum, invId, signature, shp);
    console.log("[Robokassa] webhook signature valid:", isValid);

    if (!isValid) {
      console.error("[Robokassa] webhook invalid signature", { invId, outSum, signature, shp });
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
      console.log("[Robokassa] Webhook processed successfully", { InvId: invId, duplicate: true });
      return new NextResponse(`OK${invId}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const vcFromShp = Number(shp.Shp_vc);
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

    console.log("[Robokassa] Webhook processed successfully", { InvId: invId, vcAmount });
    return new NextResponse(`OK${invId}`, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Robokassa] webhook error:", error);
    if (error instanceof Error) {
      console.error("[Robokassa] webhook error details:", error.message, error.stack);
    }
    throw error;
  }
}

export async function POST(req: NextRequest) {
  try {
    return await handleWebhook(req);
  } catch (error) {
    console.error("Robokassa webhook error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    return await handleWebhook(req);
  } catch (error) {
    console.error("Robokassa webhook error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
