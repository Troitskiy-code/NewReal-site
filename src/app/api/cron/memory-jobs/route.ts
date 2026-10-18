import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { memoryV2Enabled } from "@/lib/memoryFacts";
import { drainMemoryJobs, memoryJobStatus } from "@/lib/memoryV2";
import { getCronProvidedSecret } from "@/lib/cronAuth";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 180;
async function handle(req: NextRequest, apply: boolean) {
  const secret = process.env.CRON_SECRET;
  if (!secret || getCronProvidedSecret(req) !== secret) return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
  try {
    if (!apply || !memoryV2Enabled()) return NextResponse.json(await memoryJobStatus());
    // An operator can explicitly retry failed head jobs; automatic polling never
    // turns a permanently invalid input into an unbounded paid loop.
    const body = await req.json().catch(() => ({}));
    if (body.retryFailed === true) await prisma.memoryJob.updateMany({ where: { status: "failed" },
      data: { status: "retry", attempts: 0, availableAt: new Date(), errorCode: null } });
    return NextResponse.json({ ...await drainMemoryJobs({ limit: 1 }), ...await memoryJobStatus() });
  } catch (error) {
    errorLog("MemoryV2", "worker failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось обработать память" }, { status: 503 });
  }
}
export const GET = (req: NextRequest) => handle(req, false);
export const POST = (req: NextRequest) => handle(req, true);
