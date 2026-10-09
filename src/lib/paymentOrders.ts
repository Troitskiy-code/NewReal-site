import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { PAYMENT_PROVIDER } from "./paymentEvent";
import { normalizeCheckoutAttribution } from "./paymentAttribution";
import { METRIKA_COUNTER_ID } from "./metrika";

export function isDeclaredTestPayment(userId: string): boolean {
  return process.env["ROBOKASSA_TEST_MODE"] === "true" || process.env["ROBOKASSA_TEST_MODE"] === "1"
    || (process.env["PAYMENT_TEST_USER_IDS"] ?? "").split(",").map(s => s.trim()).filter(Boolean).includes(userId);
}
export async function registerPaymentOrder(input: {
  invoiceId: string; userId: string; kind: "purchase" | "subscription";
  amountRub: number; planId?: string; packageId?: number; period?: string; attribution?: unknown;
  reuseInvoice?: boolean;
}, client: Prisma.TransactionClient | typeof prisma = prisma) {
  const attribution = normalizeCheckoutAttribution(input.attribution);
  if (attribution?.counterId !== METRIKA_COUNTER_ID && attribution) {
    delete attribution.counterId; delete attribution.clientId;
  }
  // Reused first-pack invoices keep the original campaign and opaque order identity.
  const data = { provider: PAYMENT_PROVIDER, invoiceId: input.invoiceId, userId: input.userId, kind: input.kind,
      amountRub: input.amountRub, planId: input.planId ?? null, packageId: input.packageId ?? null,
      period: input.period ?? null, attribution: attribution ? attribution as unknown as Prisma.InputJsonValue : Prisma.DbNull,
      isTest: isDeclaredTestPayment(input.userId), createdAt: new Date() };
  const order = input.reuseInvoice ? await client.paymentOrder.upsert({
    where: { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId: input.invoiceId } }, update: {}, create: data,
  }) : await client.paymentOrder.create({ data });
  if (order.userId !== input.userId || order.kind !== input.kind || order.amountRub !== input.amountRub
    || order.planId !== (input.planId ?? null) || order.packageId !== (input.packageId ?? null)
    || order.period !== (input.period ?? null)) throw new Error("Payment order conflict");
  return order;
}
export function publicPaymentOrderId(eventId: string, orderId?: string | null): string {
  return orderId ? `po_${orderId}` : `pe_${eventId}`;
}
export function paymentOrderMatchesEvent(order: { userId: string; kind: string; amountRub: number; planId: string | null } | null,
  event: { userId: string; kind: string; amountRub: number | null; planId: string | null }): boolean {
  const kind = event.kind === "purchase" ? "purchase" : ["subscription", "subscription_pending"].includes(event.kind) ? "subscription" : null;
  return Boolean(order && kind && order.userId === event.userId && order.kind === kind
    && order.amountRub === event.amountRub && order.planId === event.planId);
}
