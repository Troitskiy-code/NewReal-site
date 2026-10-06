import { NextRequest, NextResponse, after } from "next/server";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { clientKeyFromRequest } from "@/lib/rateLimit";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiT } from "@/lib/apiI18n";
import { parseSupportTicket, supportMessageWithReference } from "@/lib/supportTicket";
import { createOrReplaySupportTicket, processSupportOutbox, SUPPORT_CLIENT_KEY_RE } from "@/lib/supportOutbox";
import { GuestSchemaMissingError, assertGuestSchemaReady } from "@/lib/guestRequestStore";

function clientIp(req: NextRequest): string {
  return clientKeyFromRequest(req);
}

export async function POST(req: NextRequest) {
  try { return await submitSupport(req); }
  catch (error) {
    errorLog("Support", "submission failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: apiT(req, "api.internalError") }, { status: 503 });
  }
}

async function submitSupport(req: NextRequest) {
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
  if (!body || typeof body !== "object" || Array.isArray(body)) {
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
    referenceTicketId: body.referenceTicketId,
  });
  if (parsed.ok === false) {
    const key =
      parsed.error === "invalid_topic"
        ? "support.invalidTopic"
        : parsed.error === "invalid_email"
          ? "support.invalidEmail"
          : parsed.error === "invalid_reference"
            ? "support.invalidReference"
            : "support.invalidMessage";
    return NextResponse.json({ error: apiT(req, key) }, { status: 400 });
  }

  const existing = await prisma.supportTicket.findUnique({
    where: { clientKey },
    select: { id: true },
  });
  if (!existing) {
    const { consumeRateLimit } = await import("@/lib/rateLimit");
    const limited = await consumeRateLimit(`support:${clientIp(req)}`, 5, 60 * 60 * 1000);
    if (!limited.ok) {
      return NextResponse.json({ error: apiT(req, "api.rateLimited") }, { status: 429 });
    }
    const emailLimit = await consumeRateLimit(`support-email:${parsed.email.toLowerCase()}`, 5, 60 * 60 * 1000);
    if (!emailLimit.ok) {
      return NextResponse.json({ error: apiT(req, "api.rateLimited") }, { status: 429 });
    }
  }

  const result = await createOrReplaySupportTicket({
    clientKey,
    topic: parsed.topic,
    email: parsed.email,
    message: supportMessageWithReference(parsed),
    userId: (await getServerSession(authOptions))?.user?.id ?? null,
  });
  if ("conflict" in result) {
    return NextResponse.json({ error: "REQUEST_CONFLICT" }, { status: 409 });
  }

  if (!result.replayed) {
    after(async () => { try { await processSupportOutbox(1); }
      catch (error) { errorLog("Support", "outbox deferred to cron", toSafeDiagnostic(error)); } });
  }

  return NextResponse.json(
    { ok: true, ticketId: result.ticketId, replayed: result.replayed },
    { status: result.replayed ? 200 : 201 }
  );
}
