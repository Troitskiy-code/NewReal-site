import { NextRequest, NextResponse } from "next/server";
import { runCharacterLifecycleTick } from "@/lib/characterLifecycle";

export const maxDuration = 60;

function isAuthorized(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return false;
  }

  const authHeader = req.headers.get("Authorization");
  return authHeader === `Bearer ${adminSecret}`;
}

export async function POST(req: NextRequest) {
  try {
    if (!isAuthorized(req)) {
      console.error("[Lifecycle] Admin update-characters unauthorized");
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const limitRaw = typeof body === "object" && body ? Number((body as { limit?: unknown }).limit) : NaN;
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : undefined;

    console.log("[Lifecycle] Admin tick started", { limit: limit ?? "default" });
    const summary = await runCharacterLifecycleTick({ limit });
    console.log("[Lifecycle] Admin tick finished", summary);

    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error("[Lifecycle] Admin update-characters failed", error);
    return NextResponse.json({ error: "Не удалось обновить персонажей" }, { status: 500 });
  }
}
