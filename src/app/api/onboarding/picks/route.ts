import { NextRequest, NextResponse } from "next/server";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { prismaPoolOverloadResponse } from "@/lib/handlePrismaError";
import { parseOnboardingGender, parseOnboardingInterests, parseOnboardingStyle } from "@/lib/onboarding";
import { getOnboardingPicks } from "@/lib/onboardingPicks";

export const dynamic = "force-dynamic";

/** Public, read-only: the "Первый шаг" counter (count=1) and its 1–3 cards. Only public cards are read. */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const page = Number.parseInt(params.get("page") ?? "0", 10);
  const query = {
    style: parseOnboardingStyle(params.get("style")),
    interests: parseOnboardingInterests(params.get("interests") ?? ""),
    gender: parseOnboardingGender(params.get("gender")),
    page: Number.isSafeInteger(page) && page >= 0 && page < 1000 ? page : 0,
  };
  try {
    const result = await getOnboardingPicks(query);
    const body = params.get("count") === "1" ? { total: result.total } : result;
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const overload = prismaPoolOverloadResponse(error);
    if (overload) return overload;
    errorLog("Onboarding", "picks", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
