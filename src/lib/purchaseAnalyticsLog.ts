// Browser diagnostics deliberately exclude identity, attribution, URLs and SDK payloads.
type PurchaseLogStage = "return_captured" | "payment_confirmed" | "counter_not_ready"
  | "dispatch_started" | "dispatch_result" | "receipt_saved" | "receipt_rejected" | "receipt_network_error";

export function logPurchaseAnalytics(
  stage: PurchaseLogStage,
  record: { invoiceId: string; orderId?: string | null },
  details: { goal?: string; attempts?: number; status?: number; state?: string } = {}
) {
  try {
    const invoiceId = /^\d{1,20}$/.test(record.invoiceId) ? record.invoiceId : null;
    const orderId = typeof record.orderId === "string" && /^(po|pe)_[a-zA-Z0-9-]{8,64}$/.test(record.orderId)
      ? record.orderId : null;
    const goal = /^(vc_purchase_success|subscription_(success|dialog|history|universe))$/.test(details.goal ?? "")
      ? details.goal : null;
    const state = /^(dispatched|callback_completed|timeout|unknown|not_ready|queued)$/.test(details.state ?? "")
      ? details.state : null;
    console.info("[PaymentAnalytics]", JSON.stringify({ stage, at: new Date().toISOString(), invoiceId, orderId,
      ...(goal ? { goal } : {}), ...(state ? { state } : {}),
      ...(Number.isInteger(details.attempts) && details.attempts! >= 0 && details.attempts! <= 3 ? { attempts: details.attempts } : {}),
      ...(Number.isInteger(details.status) && details.status! >= 100 && details.status! <= 599 ? { status: details.status } : {}) }));
  } catch {
    // Diagnostic output must never interrupt payment or goal handling.
  }
}
