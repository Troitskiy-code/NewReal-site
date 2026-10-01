export type PaymentConfirmationStatus = "idle" | "pending" | "confirmed" | "waiting";

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
