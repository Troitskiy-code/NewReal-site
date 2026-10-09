export function buildPaymentAttributionReport(rows, { from, to, refunds = null }) {
  const orders = rows.map(row => {
    const touch = row.attribution?.lastNonDirect ?? row.attribution?.firstTouch;
    const purchaseGoal = row.kind === 'purchase' ? 'vc_purchase_success' :
      ['subscription', 'subscription_pending'].includes(row.kind) ? 'subscription_success' : null;
    const receipt = (row.receipts ?? []).find(r => r.goal === purchaseGoal);
    const sourceOf = value => value?.utm_source ?? (value?.yclid ? 'yandex_click' : value?.referrerHost ?? 'direct_or_unknown');
    return { orderId: row.orderId ? `po_${row.orderId}` : `pe_${row.eventId}`, invoiceId: row.invoiceId ?? null,
      confirmedAtUtc: new Date(row.createdAt).toISOString(), kind: row.kind, planId: row.planId,
      packageId: row.packageId ?? null, cohort: row.cohort, isTest: row.isTest,
      amountRub: row.amountRub, source: purchaseGoal ? sourceOf(touch) : 'not_applicable_renewal',
      firstSource: row.attribution ? sourceOf(row.attribution.firstTouch) : null,
      lastNonDirectSource: row.attribution?.lastNonDirect ? sourceOf(row.attribution.lastNonDirect) : null,
      medium: touch?.utm_medium ?? null, campaign: touch?.utm_campaign ?? null,
      attributionAvailable: Boolean(row.attribution), legacyOrder: !row.orderId,
      clientIdAvailable: Boolean(row.attribution?.clientId), yclidAvailable: Boolean(touch?.yclid),
      analytics: row.isTest || !purchaseGoal ? 'excluded' : receipt?.state ?? 'not_reported',
      // SDK callback is advisory; dashboard attribution/delivery needs a separate reconciliation.
      metrikaDelivery: 'unverified', refundRub: refunds === null ? null : 0 };
  });
  const byOrder = new Map(orders.map(o => [o.orderId, o]));
  if (refunds !== null) {
    if (!Array.isArray(refunds)) throw new Error('Refund ledger must be an array');
    const ids = new Set();
    for (const refund of refunds) {
      const order = byOrder.get(refund.orderId);
      if (!order || typeof refund.id !== 'string' || !refund.id || ids.has(refund.id)
        || !Number.isFinite(refund.amountRub) || refund.amountRub <= 0
        || typeof refund.refundedAt !== 'string' || !refund.refundedAt.endsWith('Z') || !Number.isFinite(Date.parse(refund.refundedAt))
        || Date.parse(refund.refundedAt) < Date.parse(order.confirmedAtUtc)) throw new Error('Invalid or duplicate refund in ledger');
      ids.add(refund.id); order.refundRub += refund.amountRub;
      if (order.amountRub === null || order.refundRub > order.amountRub + 0.001) throw new Error('Refund exceeds confirmed amount');
    }
  }
  const totals = selected => ({ count: selected.length,
    grossRub: selected.reduce((sum, o) => sum + (o.amountRub ?? 0), 0),
    amountUnknown: selected.filter(o => o.amountRub === null).length,
    refundsRub: refunds === null ? null : selected.reduce((sum, o) => sum + o.refundRub, 0),
    clientCallbacks: selected.filter(o => o.analytics === 'callback_completed').length,
    analyticsNotReported: selected.filter(o => o.analytics === 'not_reported').length,
    analyticsStates: Object.fromEntries([...new Set(selected.map(o => o.analytics))].map(state => [state, selected.filter(o => o.analytics === state).length])) });
  const real = orders.filter(o => !o.isTest);
  const campaigns = new Map();
  for (const order of real.filter(o => o.cohort !== 'renewal')) {
    const key = JSON.stringify([order.source, order.medium, order.campaign]);
    const group = campaigns.get(key) ?? []; group.push(order); campaigns.set(key, group);
  }
  return { summary: { period: { fromInclusiveUtc: from, toExclusiveUtc: to },
    classificationRule: 'test = stored flag or explicit server test user IDs; other payments are not-declared-test, historical tests need operator classification',
    attributionRule: 'client-reported first touch / last non-direct, 30 days; not Yandex attribution',
    revenueBasis: 'confirmed PaymentEvent; gross before fees/taxes; refunds unknown unless explicit ledger supplied',
    real: totals(real), tests: totals(orders.filter(o => o.isTest)),
    first: totals(real.filter(o => o.cohort === 'first')), repeat: totals(real.filter(o => o.cohort === 'repeat')),
    renewals: totals(real.filter(o => o.cohort === 'renewal')),
    sourceUnknown: real.filter(o => o.cohort !== 'renewal' && !o.attributionAvailable).length,
    campaigns: [...campaigns.values()].map(group => ({ source: group[0].source, medium: group[0].medium,
      campaign: group[0].campaign, ...totals(group) })) }, orders };
}
