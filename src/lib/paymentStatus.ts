export type PaymentConfirmationStatus = "idle" | "pending" | "confirmed" | "waiting";

export type PaymentStatusKind =
  | "subscription"
  | "subscription_pending"
  | "subscription_renewal"
  | "purchase";

export type PaymentStatusResponse = {
  status: "idle" | "pending" | "confirmed";
  invId?: string;
  kind?: PaymentStatusKind | null;
  planId?: string | null;
  amountRub?: number | null;
  orderId?: string;
  analyticsExcluded?: boolean;
};

function isStatusKind(value: string): value is PaymentStatusKind {
  return (
    value === "subscription" ||
    value === "subscription_pending" ||
    value === "subscription_renewal" ||
    value === "purchase"
  );
}

export function visiblePaymentStatus(
  event: { userId: string; kind: string; planId: string | null; amountRub: number | null } | null,
  sessionUserId: string,
  invId: string
): PaymentStatusResponse {
  if (!event || event.userId !== sessionUserId) {
    return { status: "pending", invId };
  }
  return {
    status: "confirmed",
    invId,
    kind: isStatusKind(event.kind) ? event.kind : null,
    planId: event.planId,
    amountRub: event.amountRub,
  };
}

export function robokassaPaymentMarker(invId: string): string {
  return `Robokassa InvId=${invId}`;
}

export function normalizeInvId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 32) return null;
  if (!/^[0-9]+$/.test(value)) return null;
  return value;
}

export function isConfirmedRobokassaTransaction(
  description: string | null | undefined,
  invId: string
): boolean {
  if (!description) return false;
  return description === robokassaPaymentMarker(invId);
}

export function paymentStatusFromTransactions(
  descriptions: Array<string | null | undefined>,
  invId: string | null
): PaymentConfirmationStatus {
  if (!invId) return "idle";
  if (descriptions.some((item) => isConfirmedRobokassaTransaction(item, invId))) {
    return "confirmed";
  }
  return "pending";
}
