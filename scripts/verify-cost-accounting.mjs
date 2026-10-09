// Deterministic fixtures only. No DB, API keys or paid requests.
import assert from 'node:assert/strict';
import { buildAiCostReport, reconcileKodikCosts, rubUnits, rubString, estimatedRubUnits } from './lib/ai-cost-report.mjs';
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log(`PASS ${label}`); };
const event = (id, overrides = {}) => ({ id, provider: 'kodikrouter', model: 'test/model', purpose: 'chat',
  outcome: 'completed', usageSource: 'provider', costSource: 'chat_usd_estimate', accountingVersion: 2,
  inputTokens: 100, outputTokens: 10, chargedVC: 4, estimatedCostRub: 5,
  inputRubPerMillion: 10, outputRubPerMillion: 20, quotedVC: 36,
  providerRequestId: `kr_req_${id}`, providerResponseId: `gen_${id}`, ...overrides });
const ledger = (id, overrides = {}) => ({ id: `ledger_${id}`, request_id: `kr_req_${id}`,
  api_key_name: 'test_key', status: 'success', model_id: 'test/model',
  input_tokens: 100, output_tokens: 10, cost_rub: '0.006672', ...overrides });
const report = (events, rows) => buildAiCostReport(events, { ledgerRows: rows, apiKeyName: 'test_key' });
const header = report([event('a')], [ledger('a')]);
check(header.coverage.confirmedCost === 1 && header.totals.confirmedCostRubExact === '0.006672', 'exact header ID establishes RUB debit');
check(header.totals.estimatedCostRub === 0 && header.models[0].chargedCostVC === 4, 'confirmed debit supersedes estimate; actual charged VC replaces quote');
const body = report([event('b')], [ledger('b', { request_id: 'gen_b', cost_rub: '0.000541' })]);
check(body.reconciliation.responseMatches === 1 && body.totals.confirmedCostRub === 0.000541, 'provider response ID also reconciles exactly');
check(report([event('emb', { model: 'openai/text-embedding-3-small', actualModel: 'text-embedding-3-small',
  purpose: 'embedding', outputTokens: 0 })], [ledger('emb', { model_id: 'openai/text-embedding-3-small', output_tokens: 0 })]).coverage.confirmedCost === 1,
  'only verified embedding alias reconciles by exact ID and matching tokens');
check(report([event('alias', { actualModel: 'gpt-4o-mini' })], [ledger('alias', { model_id: 'openai/gpt-4o-mini' })]).coverage.confirmedCost === 0,
  'unverified model prefix differences do not invent aliases');
check(report([event('cbr', { costSource: 'chat_cbr_estimate' })]).coverage.estimatedCost === 1,
  'CBR conversion stays estimated in report');
const inferred = report([event('a')], [ledger('a', { request_id: 'different_id' })]);
check(inferred.coverage.confirmedCost === 0 && inferred.coverage.estimatedCost === 1, 'time/tokens never invent an ID match');
check(report([event('a')], [ledger('a', { api_key_name: 'other_key' })]).coverage.confirmedCost === 0, 'other API key is excluded');
check(report([event('a')], [ledger('a', { status: 'failed' })]).coverage.confirmedCost === 0, 'failed ledger row does not prove success debit');
check(report([event('a')], [ledger('a'), ledger('a')]).reconciliation.duplicateRows === 1, 'same ledger row replay is idempotent');
check(report([event('a')], [ledger('a'), ledger('a', { id: 'ledger_other' })]).reconciliation.ambiguous === 1, 'distinct rows sharing an ID remain ambiguous');
check(report([event('a'), event('other', { providerResponseId: 'kr_req_a' })], [ledger('a')]).coverage.confirmedCost === 0, 'one export row cannot pay for two events');
check(report([event('a')], [ledger('a'), ledger('b', { request_id: 'gen_a' })]).coverage.confirmedCost === 0, 'two different debit rows across the two IDs are ambiguous');
check(report([event('a')], [ledger('a'), ledger('a', { cost_rub: '3' })]).coverage.confirmedCost === 0, 'conflicting duplicate ledger IDs fail closed');
check(report([event('a')], [ledger('a'), ledger('a', { cost_rub: 0 })]).coverage.confirmedCost === 0, 'zero duplicate cannot hide a conflicting debit');
check(report([event('a')], [ledger('a'), ledger('a', { cost_rub: null })]).coverage.confirmedCost === 0, 'missing duplicate cannot hide a conflicting debit');
check(report([event('a')], [ledger('a'), ledger('a', { status: 'failed' })]).coverage.confirmedCost === 0, 'conflicting status cannot hide a duplicate ledger ID');
for (const overrides of [{ cost_rub: 0 }, { cost_rub: null }, { status: 'failed' }]) {
  for (const reverse of [false, true]) {
    const rows = [ledger('a'), ledger('a', { id: 'ledger_other', ...overrides })];
    check(report([event('a')], reverse ? rows.reverse() : rows).coverage.confirmedCost === 0,
      `distinct ledger rows remain ambiguous before cost/status filtering (${JSON.stringify(overrides)}, reverse=${reverse})`);
  }
}
check(report([event('a')], [ledger('a', { model_id: 'different/model' })]).reconciliation.mismatched === 1, 'actual model must match');
check(report([event('a')], [ledger('a', { input_tokens: 101 })]).reconciliation.mismatched === 1, 'measured tokens must match');
check(report([event('a')], [ledger('a', { cost_rub: 0 })]).reconciliation.zeroCostRows === 1, 'zero cost is unconfirmed, not proof of free usage');
check(report([event('a')], [ledger('a', { cost_rub: null })]).reconciliation.missingCostRows === 1, 'missing cost remains visible');
check(report([event('a')], [ledger('a', { cost_rub: '-1' })]).reconciliation.invalidRows === 1, 'negative debit is rejected');
check(report([event('a')], [ledger('a', { cost_rub: 'Infinity' })]).reconciliation.invalidRows === 1, 'nonfinite debit is rejected');
check(report([event('a')], [ledger('a', { request_id: 'sk_secret_fixture' })]).coverage.confirmedCost === 0, 'secret-shaped IDs are not used');
assert.throws(() => reconcileKodikCosts([event('a')], [ledger('a')], undefined)); checks++;
const old = report([event('legacy', { accountingVersion: 1, costSource: 'provider', reportedCostRub: 100, estimatedCostRub: 0.1 })]);
check(old.totals.confirmedCostRub === 0 && old.totals.legacyUnverifiedRub === 100 && old.totals.estimatedCostRub === 0.1, 'legacy conversions are not relabelled as confirmed debits');
const failed = report([event('f', { outcome: 'failed', usageSource: 'missing', estimatedCostRub: null }), event('p', { outcome: 'pending' }), event('s', { outcome: 'submitted' })]);
check(failed.coverage.unknownCost === 3 && failed.totals.estimatedCostRub === 0, 'failed/pending/submitted attempts remain unknown');
const knownFailure = report([event('f', { outcome: 'failed' })], [ledger('f')]);
check(knownFailure.coverage.confirmedCost === 1 && knownFailure.totals.confirmedCostRub > 0, 'confirmed provider debit survives application failure');
const mixed = report([event('a'), event('free', { chargedVC: 0, audience: 'guest' })], [ledger('a')]);
check(mixed.models[0].chargedCompleted === 1 && mixed.models[0].chargedCostCount === 1 && mixed.models[0].chargedProviderUsageCount === 1, 'guest/free usage is separate from paid unit cost');
const sums = report([event('a'), event('b')], [ledger('a', { cost_rub: '0.1' }), ledger('b', { cost_rub: '0.2' })]);
check(sums.totals.confirmedCostRubExact === '0.3', 'decimal ledger totals avoid floating-point addition errors');
check(rubString(rubUnits('0.0000001')) === '0.0000001' && rubUnits(1e-7) === rubUnits('0.0000001'), 'scientific notation is handled exactly');
const confidential = report([event('a', { actorHash: 'secret_actor', email: 'secret_email', prompt: 'secret_prompt' })],
  [ledger('a', { api_key: 'secret_api_key', prompt: 'secret_dialog' })]);
check(!JSON.stringify(confidential).includes('secret_'), 'report never returns actors, prompts, keys or raw rows');
check(header.coverage.attempts === header.coverage.confirmedCost + header.coverage.estimatedCost + header.coverage.unknownCost, 'cost classes partition all attempts');
check(rubUnits(6.825000000000001e-6) === null && rubString(estimatedRubUnits(6.825000000000001e-6)) === '0.000006825',
  'Float tail normalized only for estimates; strict ledger parser unchanged');
check(rubString(estimatedRubUnits(0.0004738499999999999)) === '0.00047385', 'small embedding Float is not lost as unknown');
check(rubString(estimatedRubUnits(1.23456789123456e-6)) === '0.000001234567891235',
  'small USD-conversion Float rounds to report precision instead of disappearing');
check(rubString(estimatedRubUnits(1.23456789123456e-10)) === '0.000000000123456789',
  'very small estimate is retained without binary toFixed tails');
check(estimatedRubUnits('0.000000000000000001') === rubUnits('0.000000000000000001'), 'exact decimal estimates retain all supported digits');
for (const invalid of [NaN, Infinity, -0.1, null, undefined, 1e-19, '-1', '0.0000000000000000001']) {
  check(estimatedRubUnits(invalid) === null, 'invalid or unsupported precision stays unknown, never zero');
}
const smallCosts = report([event('small1', { estimatedCostRub: 6.825000000000001e-6 }),
  event('small2', { purpose: 'embedding', model: 'other/model', estimatedCostRub: 0.0004738499999999999 })]);
check(smallCosts.coverage.estimatedCost === 2 && smallCosts.coverage.unknownCost === 0
  && smallCosts.totals.estimatedCostRubExact === '0.000480675', 'estimates sum exactly across different model groups');
const aborted = report([event('partial', { outcome: 'failed', chargedVC: 0, estimatedCostRub: 0.1 }),
  event('cancelled', { outcome: 'cancelled', chargedVC: 0, usageSource: 'missing', apiSurface: 'chat_completions',
    providerCostNative: 0.02, estimatedCostRub: 1.8 })]);
check(aborted.coverage.estimatedCost === 2 && aborted.totals.estimatedCostRubExact === '1.9'
  && aborted.models[0].completed === 0 && aborted.models[0].chargedCostVC === 0,
  'known provider usage/cost survives failed/cancelled replies without paid-success statistics');
check(report([event('quote', { outcome: 'cancelled', usageSource: 'missing', costSource: 'configured_estimate' })]).coverage.unknownCost === 1,
  'unmeasured cancelled quote never becomes a known cost');
console.log(`Cost accounting verification: ${checks} passed`);
