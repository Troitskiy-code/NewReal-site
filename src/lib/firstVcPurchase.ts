import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { RobokassaCheckout } from "./robokassa";

async function hasPaidHistory(tx: Prisma.TransactionClient, userId: string) {
  const [event, transaction] = await Promise.all([
    tx.paymentEvent.findFirst({ where: { userId }, select: { id: true } }),
    tx.transaction.findFirst({ where: { userId, type: { in: ["purchase", "subscription"] } }, select: { id: true } }),
  ]);
  return Boolean(event || transaction);
}

export async function firstVcAvailability(userId: string) {
  const claim = await prisma.firstVcPurchase.findUnique({ where: { userId }, select: { status: true } });
  if (claim) return { available: claim.status === "pending", reserved: claim.status === "pending" };
  return { available: !await hasPaidHistory(prisma, userId), reserved: false };
}

export async function reserveFirstVcCheckout(userId: string, build: (invoiceId?: string) => RobokassaCheckout) {
  return prisma.$transaction(async tx => {
    const owners = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    if (!owners.length) return null;
    const existing = await tx.firstVcPurchase.findUnique({ where: { userId } });
    if (existing) {
      if (existing.status !== "pending") return null;
      // Re-sign the return URL/locale for this visit while keeping the same invoice.
      const checkout = build(existing.invoiceId);
      await tx.firstVcPurchase.update({ where: { userId }, data: { checkout: checkout as unknown as Prisma.InputJsonValue } });
      return checkout;
    }
    if (await hasPaidHistory(tx, userId)) return null;
    const checkout = build();
    await tx.firstVcPurchase.create({ data: { userId, invoiceId: checkout.fields.InvId, checkout: checkout as unknown as Prisma.InputJsonValue } });
    return checkout;
  });
}
