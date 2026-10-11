import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AIService } from "@/lib/services/ai";

// The callback is unauthenticated, so its payload is only a hint: the result and any
// refund come from MuAPI itself via syncStatus, using the server's API key.
export async function POST(req) {
  try {
    const data = await req.json().catch(() => null);
    const requestId = data?.id || data?.request_id;

    if (!requestId || typeof requestId !== "string") {
      return NextResponse.json({ error: "Missing prediction identifier" }, { status: 400 });
    }

    const creation = await prisma.creation.findFirst({
      where: { requestId },
      select: { id: true, status: true },
    });

    if (!creation) {
      return NextResponse.json({ error: "Creation record not found" }, { status: 404 });
    }

    if (creation.status !== "processing") {
      return NextResponse.json({ success: true, message: "Already processed" });
    }

    const synced = await AIService.syncStatus(creation.id);
    return NextResponse.json({ success: true, status: synced?.status ?? creation.status });
  } catch (error) {
    errorLog("Server", "MUAPI webhook processing error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Операция временно недоступна" }, { status: 500 });
  }
}
