import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  readAnonymousSessionId,
  clearAnonymousSessionCookie,
} from "@/lib/anonymousSession";
import { transferAnonymousChatToUser } from "@/lib/anonymousTransfer";
import { clientKeyFromRequest, consumeRateLimit } from "@/lib/rateLimit";
import { apiT } from "@/lib/apiI18n";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: apiT(req, "api.unauthorized") }, { status: 401 });
  }

  const limited = consumeRateLimit(`anon-transfer:${session.user.id}:${clientKeyFromRequest(req)}`, 10, 60_000);
  if (!limited.ok) {
    return NextResponse.json({ error: apiT(req, "api.rateLimited") }, { status: 429 });
  }

  const guestSessionId = readAnonymousSessionId(req);
  if (!guestSessionId) {
    return NextResponse.json({ ok: true, copied: 0, characterIds: [], alreadyTransferred: true });
  }

  const result = await transferAnonymousChatToUser({
    sessionId: guestSessionId,
    userId: session.user.id,
  });

  if (result.ok === false) {
    const status =
      result.code === "expired" ? 410 : result.code === "not_found" ? 404 : result.code === "schema" ? 503 : 409;
    return NextResponse.json({ error: result.code }, { status });
  }

  const response = NextResponse.json(result);
  clearAnonymousSessionCookie(response);
  return response;
}
