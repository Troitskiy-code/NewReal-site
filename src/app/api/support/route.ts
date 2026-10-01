import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiT } from "@/lib/apiI18n";
import { parseSupportTicket, type SupportTicketInput } from "@/lib/supportTicket";
import { createOrReplaySupportTicket, processSupportOutbox, SUPPORT_CLIENT_KEY_RE } from "@/lib/supportOutbox";
import { GuestSchemaMissingError, assertGuestSchemaReady } from "@/lib/guestRequestStore";

function clientIp(req: NextRequest): string {
  if (process.env.TRUST_PROXY === "1") {
    return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(req: NextRequest) {
  try {
    await assertGuestSchemaReady();
  } catch (error) {
    if (error instanceof GuestSchemaMissingError) {
      return NextResponse.json({ error: apiT(req, "api.internalError"), code: "SCHEMA_NOT_READY" }, { status: 503 });
    }
    throw error;
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: apiT(req, "support.invalidMessage") }, { status: 400 });
  }

  const clientKey = typeof body.clientKey === "string" ? body.clientKey : "";
  if (!SUPPORT_CLIENT_KEY_RE.test(clientKey)) {
    return NextResponse.json({ error: apiT(req, "support.invalidMessage") }, { status: 400 });
  }

  const parsed = parseSupportTicket({
    topic: body.topic,
    email: body.email,
    message: body.message,
  });
  if (parsed.ok === false) {
    const key =
      parsed.error === "invalid_topic"
        ? "support.invalidTopic"
        : parsed.error === "invalid_email"
          ? "support.invalidEmail"
          : "support.invalidMessage";
    return NextResponse.json({ error: apiT(req, key) }, { status: 400 });
  }

  const existing = await prisma.supportTicket.findUnique({
    where: { clientKey },
    select: { id: true },
  });
  if (!existing) {
    const { consumeRateLimit } = await import("@/lib/rateLimit");
    const limited = consumeRateLimit(`support:${clientIp(req)}`, 5, 60 * 60 * 1000);
    if (!limited.ok) {
      return NextResponse.json({ error: apiT(req, "api.rateLimited") }, { status: 429 });
    }
    const recent = await prisma.supportTicket.count({
      where: {
        email: parsed.email,
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
    });
    if (recent >= 5) {
      return NextResponse.json({ error: apiT(req, "api.rateLimited") }, { status: 429 });
    }
  }

  const result = await createOrReplaySupportTicket({
    clientKey,
    topic: parsed.topic,
    email: parsed.email,
    message: parsed.message,
    userId: (await getServerSession(authOptions))?.user?.id ?? null,
  });
  if ("conflict" in result) {
    return NextResponse.json({ error: "REQUEST_CONFLICT" }, { status: 409 });
  }

  if (!result.replayed) {
    void processSupportOutbox(1).catch(() => undefined);
  }

  return NextResponse.json(
    { ok: true, ticketId: result.ticketId, replayed: result.replayed },
    { status: result.replayed ? 200 : 201 }
  );
}
