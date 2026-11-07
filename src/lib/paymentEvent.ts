import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { robokassaPaymentMarker } from "@/lib/paymentStatus";

export const PAYMENT_PROVIDER = "robokassa";

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function claimPaymentEvent(params: {
  invoiceId: string;
  userId: string;
  kind: string;
  planId?: string | null;
  amountRub?: number | null;
}): Promise<"claimed" | "duplicate"> {
  try {
    await prisma.paymentEvent.create({
      data: paymentEventCreateData(params.invoiceId, params.userId, params.kind, {
        planId: params.planId,
        amountRub: params.amountRub,
      }),
    });
    return "claimed";
  } catch (error) {
    if (isUniqueConstraintError(error)) return "duplicate";
    throw error;
  }
}

export async function backfillPaymentEventsFromTransactions(): Promise<{ inserted: number; skipped: number }> {
  const rows = await prisma.transaction.findMany({
    where: { description: { startsWith: "Robokassa InvId=" } },
    select: { id: true, userId: true, type: true, description: true, createdAt: true },
  });
  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    const invoiceId = /^Robokassa InvId=(\d{1,20})(?:\s|$)/.exec(row.description)?.[1];
    if (!invoiceId) {
      skipped += 1;
      continue;
    }
    try {
      await prisma.paymentEvent.create({
        data: {
          id: `bf_${row.id}`,
          provider: PAYMENT_PROVIDER,
          invoiceId,
          userId: row.userId,
          kind: row.type,
          createdAt: row.createdAt,
        },
      });
      inserted += 1;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { inserted, skipped };
}

export function parseConfirmedAmountRub(raw: string | null | undefined): number | null {
  if (!raw || !/^\d+(?:[.,]0{1,6})?$/.test(raw)) return null;
  const amount = Number(raw.replace(",", "."));
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 10_000_000 ? amount : null;
}

export function paymentEventCreateData(
  invoiceId: string,
  userId: string,
  kind: string,
  analytics?: { planId?: string | null; amountRub?: number | null }
) {
  return {
    provider: PAYMENT_PROVIDER,
    invoiceId,
    userId,
    kind,
    planId: analytics?.planId ?? null,
    amountRub: analytics?.amountRub ?? null,
  };
}

export { robokassaPaymentMarker };
