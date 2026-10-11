import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyKieWebhook } from "@/lib/kieAi";
import { reconcileAvatarJob } from "@/lib/kieAvatarJobs";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { readAvatarBody, AvatarBodyTooLarge } from "@/lib/avatarRequest";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(req: NextRequest) {
  try {
    if (!process.env['KIE_WEBHOOK_HMAC_KEY']) return NextResponse.json({ error: "Unavailable" }, { status: 503 });
    const raw = await readAvatarBody(req, 16_384);
    let body;
    try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid body" }, { status: 400 }); }
    const taskId = body?.data?.taskId;
    if (!verifyKieWebhook(taskId, req.headers.get("x-webhook-timestamp"), req.headers.get("x-webhook-signature"))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const job = await prisma.avatarGeneration.findUnique({ where: { providerTaskId: taskId } });
    // The signature covers taskId/timestamp, not the full payload. Fetch authoritative status.
    if (job) {
      await prisma.avatarGeneration.updateMany({ where: { id: job.id, state: "pending" }, data: { nextPollAt: new Date() } });
      await reconcileAvatarJob(job.id);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AvatarBodyTooLarge) return NextResponse.json({ error: "Too large" }, { status: 413 });
    errorLog("KieAvatar", "Callback failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  }
}
