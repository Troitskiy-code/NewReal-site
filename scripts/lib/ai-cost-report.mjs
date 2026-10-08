// Read-only accounting. Never return raw export rows, actors or response bodies.
const SCALE = 18;
const UNIT = 10n ** BigInt(SCALE);
export function rubUnits(value) {
  if (value == null || value === '' || typeof value === 'object') return null;
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value));
  if (!match) return null;
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30) return null;
  let digits = (match[1] + (match[2] ?? '')).replace(/^0+(?=\d)/, '');
  const shift = SCALE + exponent - (match[2]?.length ?? 0);
  if (shift < 0) {
    if (!digits.endsWith('0'.repeat(-shift))) return null;
    digits = digits.slice(0, shift) || '0';
  } else digits += '0'.repeat(shift);
  return digits.length <= 48 ? BigInt(digits) : null;
}
export function rubString(units) {
  const fraction = (units % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return (units / UNIT).toString() + (fraction ? '.' + fraction : '');
}
const rubNumber = units => Number(rubString(units));
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
  && !/^(sk[-_]|crya_|re_|bearer)/i.test(value) ? value : null;
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function reconcileKodikCosts(events, rows, apiKeyName) {
  if (!Array.isArray(rows) || rows.length > 500_000 || typeof apiKeyName !== 'string' || !apiKeyName.trim()) {
    throw new Error('Explicit export array and API key name are required');
  }
  const summary = { supplied: true, scopedRows: 0, successfulRows: 0, duplicateRows: 0,
    invalidRows: 0, zeroCostRows: 0, missingCostRows: 0, matched: 0, ambiguous: 0,
    mismatched: 0, headerMatches: 0, responseMatches: 0 };
  const ledger = [], seenRows = new Map(), seenRequests = new Set(), blockedIds = new Set();
  let exportRub = 0n;
  for (const row of rows) {
    if (!row || row.api_key_name !== apiKeyName) continue;
    summary.scopedRows++;
    if (row.status === 'success') summary.successfulRows++;
    const requestId = id(row.request_id), units = rubUnits(row.cost_rub);
    const input = count(row.input_tokens ?? row.tokens_in), output = count(row.output_tokens ?? row.tokens_out);
    const signature = JSON.stringify([requestId, row.model_id, input, output,
      units === null ? 'invalid_or_missing' : rubString(units), row.timestamp, row.status]);
    // Same ledger row is idempotent; different rows with the same ID are ambiguous.
    const ledgerId = id(row.id);
    if (ledgerId && seenRows.has(ledgerId)) {
      if (seenRows.get(ledgerId).signature === signature) summary.duplicateRows++;
      else {
        summary.invalidRows++;
        blockedIds.add(requestId); blockedIds.add(seenRows.get(ledgerId).requestId);
      }
      continue;
    }
    if (ledgerId) seenRows.set(ledgerId, { signature, requestId });
    // Uniqueness covers all scoped rows, including failed/missing/zero charges.
    // Filtering those first would conceal a second owner of the request ID.
    if (requestId) {
      if (seenRequests.has(requestId)) blockedIds.add(requestId);
      seenRequests.add(requestId);
    }
    if (row.status !== 'success') continue;
    if (row.cost_rub == null || row.cost_rub === '') { summary.missingCostRows++; continue; }
    if (units === 0n) { summary.zeroCostRows++; continue; }
    if (!requestId || units === null || typeof row.model_id !== 'string') { summary.invalidRows++; continue; }
    ledger.push({ requestId, units, model: row.model_id, input, output });
    exportRub += units;
  }
  const ledgerById = new Map(), eventById = new Map();
  for (let index = 0; index < ledger.length; index++) {
    const key = ledger[index].requestId;
    if (!ledgerById.has(key)) ledgerById.set(key, []);
    ledgerById.get(key).push(index);
  }
  for (const event of events.filter(e => e.provider === 'kodikrouter')) {
    for (const key of new Set([id(event.providerRequestId), id(event.providerResponseId)].filter(Boolean))) {
      if (!eventById.has(key)) eventById.set(key, new Set());
      eventById.get(key).add(event.id);
    }
  }
  const candidates = new Map(), rowOwners = new Map();
  for (const event of events.filter(e => e.provider === 'kodikrouter')) {
    const keys = new Set([id(event.providerRequestId), id(event.providerResponseId)].filter(Boolean));
    const indices = new Set([...keys].flatMap(key => ledgerById.get(key) ?? []));
    if (!indices.size) continue;
    if (indices.size !== 1 || [...keys].some(key => blockedIds.has(key) || eventById.get(key)?.size > 1)) {
      summary.ambiguous++; continue;
    }
    const index = [...indices][0], row = ledger[index];
    if (row.model !== (event.actualModel ?? event.model)
      || (event.usageSource === 'provider' && (
        row.input === null || row.output === null || row.input !== event.inputTokens || row.output !== event.outputTokens))) {
      summary.mismatched++; continue;
    }
    candidates.set(event.id, { index, units: row.units,
      kind: row.requestId === event.providerRequestId ? 'header' : 'response' });
    if (!rowOwners.has(index)) rowOwners.set(index, []);
    rowOwners.get(index).push(event.id);
  }
  const matched = new Map(); let matchedRub = 0n;
  for (const [eventId, item] of candidates) {
    if (rowOwners.get(item.index).length !== 1) { summary.ambiguous++; continue; }
    matched.set(eventId, item.units); matchedRub += item.units; summary.matched++;
    summary[item.kind === 'header' ? 'headerMatches' : 'responseMatches']++;
  }
  return { matched, summary: { ...summary, exportSuccessRub: rubNumber(exportRub),
    exportSuccessRubExact: rubString(exportRub), matchedRub: rubNumber(matchedRub), matchedRubExact: rubString(matchedRub),
    unmatchedExportRows: ledger.length - matched.size, unmatchedExportRub: rubNumber(exportRub - matchedRub),
    scope: 'Export totals cover the supplied file/key, not necessarily the event report period. No timezone or endpoint is inferred.' } };
}

const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * p, index = Math.floor(position);
  return sorted[index] + (sorted[Math.ceil(position)] - sorted[index]) * (position - index);
};
const estimateSources = new Set(['chat_usd_estimate', 'catalog_estimate', 'configured_estimate']);

export function buildAiCostReport(events, { from, to, ledgerRows, apiKeyName } = {}) {
  const reconciliation = ledgerRows ? reconcileKodikCosts(events, ledgerRows, apiKeyName)
    : { matched: new Map(), summary: { supplied: false } };
  const groups = new Map();
  for (const event of events) {
    const key = JSON.stringify([event.provider, event.actualModel ?? event.model, event.purpose]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const models = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    const group = { provider: first.provider, model: first.actualModel ?? first.model, purpose: first.purpose,
      attempts: rows.length, guestAttempts: 0, completed: 0, failed: 0, pending: 0, asyncSubmitted: 0,
      translationCharacters: 0, providerUsageCount: 0, providerCompletedUsageCount: 0,
      confirmedCostCount: 0, reportedCostCount: 0, estimatedCostCount: 0, unknownCostCount: 0,
      legacyReportedCostCount: 0, chargedVC: 0, chargedCompleted: 0, chargedCostCount: 0,
      chargedConfirmedCostCount: 0, chargedProviderUsageCount: 0, chargedCostVC: 0, costSources: {} };
    let confirmed = 0n, estimated = 0n, legacy = 0n, chargedRub = 0n;
    const measured = [], chargedMeasured = [], completed = [], charged = [];
    for (const event of rows) {
      const done = event.outcome === 'completed', billed = done && event.chargedVC > 0;
      group.guestAttempts += event.audience === 'guest' ? 1 : 0;
      group.completed += done ? 1 : 0;
      group.failed += ['failed', 'cancelled'].includes(event.outcome) ? 1 : 0;
      group.pending += event.outcome === 'pending' ? 1 : 0;
      group.asyncSubmitted += event.outcome === 'submitted' ? 1 : 0;
      group.translationCharacters += count(event.inputCharacters) ?? 0;
      group.chargedVC += count(event.chargedVC) ?? 0;
      if (event.usageSource === 'provider') {
        group.providerUsageCount++;
        if (done) { group.providerCompletedUsageCount++; measured.push(event); }
        if (billed) { group.chargedProviderUsageCount++; chargedMeasured.push(event); }
      }
      if (done) completed.push(event);
      if (billed) { group.chargedCompleted++; charged.push(event); }
      const old = rubUnits(event.reportedCostRub);
      if (old !== null) { legacy += old; group.legacyReportedCostCount++; }
      const actual = reconciliation.matched.get(event.id);
      const approximate = done && (event.accountingVersion !== 2 || estimateSources.has(event.costSource))
        ? rubUnits(event.estimatedCostRub) : null;
      let effective = null, source = 'unknown';
      if (actual !== undefined) {
        confirmed += actual; group.confirmedCostCount++; group.reportedCostCount++;
        effective = actual; source = 'ledger_confirmed';
      } else if (approximate !== null) {
        estimated += approximate; group.estimatedCostCount++; effective = approximate;
        source = event.accountingVersion === 2 ? event.costSource : 'legacy_catalog_estimate';
      } else group.unknownCostCount++;
      group.costSources[source] = (group.costSources[source] ?? 0) + 1;
      if (billed && effective !== null) {
        group.chargedCostCount++; chargedRub += effective; group.chargedCostVC += event.chargedVC;
        group.chargedConfirmedCostCount += actual !== undefined ? 1 : 0;
      }
    }
    const stats = (list, prefix = '') => {
      const input = list.map(e => number(e.inputTokens)).filter(n => n !== null);
      const output = list.map(e => number(e.outputTokens)).filter(n => n !== null);
      const name = key => prefix ? prefix + key[0].toUpperCase() + key.slice(1) : key;
      return { [name('averageInputTokens')]: average(input), [name('averageOutputTokens')]: average(output),
        [name('p50InputTokens')]: percentile(input, 0.5), [name('p50OutputTokens')]: percentile(output, 0.5),
        [name('p95InputTokens')]: percentile(input, 0.95), [name('p95OutputTokens')]: percentile(output, 0.95) };
    };
    const prices = charged.length ? charged : completed;
    models.push({ ...group, ...stats(measured), ...stats(chargedMeasured, 'charged'),
      confirmedCostRub: rubNumber(confirmed), confirmedCostRubExact: rubString(confirmed),
      reportedCostRub: rubNumber(confirmed), estimatedCostRub: rubNumber(estimated),
      legacyUnverifiedRub: rubNumber(legacy), chargedCostRub: rubNumber(chargedRub),
      inputRubPerMillion: average(prices.map(e => number(e.inputRubPerMillion)).filter(n => n !== null)),
      outputRubPerMillion: average(prices.map(e => number(e.outputRubPerMillion)).filter(n => n !== null)),
      priceVC: average(prices.map(e => number(e.quotedVC)).filter(n => n !== null)),
      averageChargedVC: average(charged.map(e => e.chargedVC)) });
  }
  models.sort((a, b) => a.purpose.localeCompare(b.purpose) || a.model.localeCompare(b.model));
  const total = key => models.reduce((sum, row) => sum + (row[key] ?? 0), 0);
  const exactConfirmed = models.reduce((sum, row) => sum + rubUnits(row.confirmedCostRubExact), 0n);
  return { schemaVersion: 2, generatedAt: new Date().toISOString(), from, to,
    coverage: { attempts: total('attempts'), providerUsage: total('providerUsageCount'),
      confirmedCost: total('confirmedCostCount'), reportedCost: total('confirmedCostCount'),
      estimatedCost: total('estimatedCostCount'), unknownCost: total('unknownCostCount'), pending: total('pending'),
      legacyUnverifiedCost: total('legacyReportedCostCount') },
    totals: { confirmedCostRub: rubNumber(exactConfirmed), confirmedCostRubExact: rubString(exactConfirmed),
      reportedCostRub: rubNumber(exactConfirmed), estimatedCostRub: total('estimatedCostRub'),
      legacyUnverifiedRub: total('legacyUnverifiedRub'), chargedVC: total('chargedVC') },
    reconciliation: reconciliation.summary,
    limitations: [
      'Only unique exact-ID matches to positive RUB debits in the supplied key-scoped export are ledger-confirmed. No time/token-only matches.',
      'Chat usage.cost is documented as total USD including markup/cache discounts. Configured USD/RUB conversion is an estimate; no additional 10%.',
      'Embedding native cost currency/markup are unverified. RUB catalog input prices already include markup and remain estimates.',
      'Legacy reportedCostRub amounts are unverified and excluded from confirmed totals. No historical cost or response ID is invented.',
      'Catalog estimates do not apply cache-read discounts. Cache-write costs without a known tariff stay unknown unless a chat USD estimate is available.',
      'Unknown, failed, pending and async-submission costs are not zero. Export and event periods may differ; no timezone is inferred.',
      'Avatar/translation costs are configured estimates; Createya/translation invoices and failed charges need separate reconciliation.',
    ], models };
}
