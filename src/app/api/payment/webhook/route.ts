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
    console.log("[Robokassa] parsed payload from searchParams:", {
      outSum: queryOutSum,
      invId: queryInvId,
      signature: querySignature,
      shp: queryShp,
    });
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
    const payload = {
      outSum: firstParam(body, "OutSum", "out_summ", "outsum"),
      invId: firstParam(body, "InvId", "inv_id", "invid"),
      signature: firstParam(body, "SignatureValue", "crc", "signaturevalue"),
      shp: extractShpParams(body.entries()),
    };
    console.log("[Robokassa] parsed payload from formData:", payload);
    return payload;
  }

  const empty = {
    outSum: queryOutSum,
    invId: queryInvId,
    signature: querySignature,
    shp: queryShp,
  };
  console.log("[Robokassa] parsed payload empty/partial:", empty);
  return empty;
}

async function readRawWebhookLog(req: NextRequest) {
  const headers = Object.fromEntries(req.headers.entries());
  let bodyText: string | null = null;
  let searchParams: Record<string, string> | null = null;

  if (req.method === "POST") {
    try {
      bodyText = await req.clone().text();
    } catch (error) {
      bodyText = `(failed to read body: ${error instanceof Error ? error.message : String(error)})`;
    }
  } else if (req.method === "GET") {
    searchParams = Object.fromEntries(req.nextUrl.searchParams.entries());
  }

  return {
    method: req.method,
    url: req.url,
    headers,
    searchParams,
    body: bodyText,
  };
}

async function handleWebhook(req: NextRequest) {
  try {
    const rawLog = await readRawWebhookLog(req);
    console.log("[Robokassa] raw webhook request:", rawLog);
    console.log("[Robokassa] request method:", rawLog.method);
    console.log("[Robokassa] request headers:", rawLog.headers);
    console.log("[Robokassa] request URL:", rawLog.url);
    if (rawLog.method === "POST") {
      console.log("[Robokassa] request body:", rawLog.body);
    }
    if (rawLog.method === "GET") {
      console.log("[Robokassa] request searchParams:", rawLog.searchParams);
    }

    const { outSum, invId, signature, shp } = await parseWebhookPayload(req);
    console.log("[Robokassa] webhook params:", { outSum, invId, signature, shp });

    const userId = shpValue(shp, "Shp_userId");

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
