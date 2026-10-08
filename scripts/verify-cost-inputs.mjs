// Synthetic filesystem and HTTP only; never reads .env or contacts CBR/providers.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { parseKodikCostExport } from './lib/kodik-cost-export.mjs';
const require = createRequire(import.meta.url);
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; console.log(`PASS ${label}`); }
function rejects(fn, label) { assert.throws(fn); checks++; console.log(`PASS ${label}`); }
const now = Date.parse('2026-10-08T18:00:00Z');
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
function currencyFixture({ file, fail = false, date = '08.10.2026' } = {}) {
  let requests = 0;
  const saved = new Map();
  const exports = {};
  const code = ts.transpileModule(readFileSync('src/lib/currencyRates.ts','utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const fakeFs = {
    readFileSync: path => saved.get(path) ?? (file ? JSON.stringify(file) : (() => { throw new Error('missing'); })()),
    writeFileSync: (path, text) => saved.set(path,text),
  };
  const dependency = name => name === '@/lib/logger' ? { errorLog() {}, toSafeDiagnostic: () => ({category:'error'}) }
    : name === 'fs' ? fakeFs : require(name);
  const fetch = async () => {
    requests++;
    if (fail) throw new Error('synthetic offline');
    return { ok:true, text: async () => `<ValCurs Date="${date}"><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>91,23</Value></Valute><Valute><CharCode>EUR</CharCode><Nominal>1</Nominal><Value>100,25</Value></Valute></ValCurs>` };
  };
  new Function('require','module','exports','fetch','Date','console',code)(dependency,{exports},exports,fetch,Clock,{log(){}});
  return { api:exports, requests:() => requests, saved };
}
const fresh = currencyFixture();
await Promise.all([fresh.api.getCurrencyRates({forceRefresh:true}),fresh.api.getCurrencyRates({forceRefresh:true})]);
check(fresh.requests() === 1, 'parallel currency refreshes make one CBR request');
check(await fresh.api.getAccountingUsdRub() === 91.23, 'fresh CBR USD rate is used without a manual env value');
const cached = [...fresh.saved.values()].map(JSON.parse)[0];
check(cached.source === 'cbr' && cached.rateDate === '2026-10-08', 'cron cache preserves CBR provenance and effective date');
const offline = currencyFixture({fail:true});
check((await offline.api.getCurrencyRates()).USD === 90 && await offline.api.getAccountingUsdRub() === null,
  'display fallback 90 is never an accounting FX rate');
const stale = currencyFixture({fail:true,file:{USD:95,EUR:105,source:'cbr',rateDate:'2026-10-07',updatedAt:'2026-10-07T10:00:00Z'}});
check(await stale.api.getAccountingUsdRub() === null, 'stale cached CBR rate is refused when refresh fails');
const legacy = currencyFixture({fail:true,file:{USD:90,EUR:100,updatedAt:'2026-10-08T17:00:00Z'}});
check(await legacy.api.getAccountingUsdRub() === null, 'legacy cache without provenance cannot masquerade as CBR');
check(legacy.requests() === 0, 'accounting does not delay chat with external currency HTTP');
check(!fresh.api.isAccountingCurrencyRate({...cached,updatedAt:'2026-10-09T18:00:00Z'},now), 'future refresh time is rejected');
check(!fresh.api.isAccountingCurrencyRate({...cached,rateDate:'2026-09-01'},now), 'recent download cannot conceal an old effective rate date');
const badDate = currencyFixture({date:'30.02.2026'});
check(await badDate.api.getAccountingUsdRub() === null, 'invalid CBR calendar date never produces accounting FX');

const modules = new Map();
function load(file) {
  file = resolve(file);
  if (file.endsWith('.json')) return JSON.parse(readFileSync(file,'utf8'));
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file,exports);
  const code = ts.transpileModule(readFileSync(file,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  new Function('require','module','exports',code)(name => {
    if (!name.startsWith('.')) return require(name);
    const path = resolve(dirname(file),name);
    return load(path.endsWith('.json') ? path : path+'.ts');
  },{exports},exports);
  return exports;
}
const prices = load('src/lib/kodikCostRates.ts');
delete process.env['AI_COST_RATES_RUB_JSON'];
for (const alias of ['openai/text-embedding-3-small','text-embedding-3-small']) {
  check(prices.getKodikCostRates(alias).input === 1.95 && prices.getKodikCostRates(alias).output === 0,
    `embedding snapshot covers ${alias}`);
}
check(prices.getKodikCostRates('x-ai/grok-4.20').input === 121.58, 'collected catalog fills missing Grok rates');
check(prices.getKodikCostRates('unpriced/model').input === null, 'unknown model has no invented snapshot quote');
check(prices.getKodikCostRates('text-embedding-3-small',{pricePer1MInput:2}).input === 2, 'updated DB catalog precedes dated snapshot');
process.env['AI_COST_RATES_RUB_JSON'] = '{"openai/text-embedding-3-small":{"input":3,"output":0}}';
check(prices.getKodikCostRates('text-embedding-3-small').input === 3, 'explicit canonical override survives response alias');
process.env['AI_COST_RATES_RUB_JSON'] = 'broken';
check(prices.getKodikCostRates('text-embedding-3-small').input === 1.95, 'invalid optional override does not break accounting');
delete process.env['AI_COST_RATES_RUB_JSON'];

const header = 'request_id;id;api_key_name;timestamp;model_id;status;input_tokens;output_tokens;cost_rub';
const line = 'kr_req_fixture;ledger_fixture;NewReal Chat;2026-10-08T15:59:39;openai/text-embedding-3-small;success;84;0;0,0001638';
const csv = `\uFEFF${header}\r\n${line}\r\n`;
const parsed = parseKodikCostExport(csv,{format:'csv',naiveTimezone:'UTC'});
check(parsed[0].cost_rub === '0.0001638' && parsed[0].timestamp === '2026-10-08T15:59:39.000Z', 'CSV preserves fractional RUB and verified UTC');
check(parsed[0].input_tokens === 84 && parsed[0].output_tokens === 0, 'CSV token counts become bounded integers, zero retained');
rejects(() => parseKodikCostExport(csv,{format:'csv'}), 'naive timestamps require explicit timezone authorization');
rejects(() => parseKodikCostExport(csv,{format:'csv',naiveTimezone:'Europe/Moscow'}), 'unsupported naive timezone cannot silently change dates');
rejects(() => parseKodikCostExport(csv.replace('0,0001638','-1'),{format:'csv',naiveTimezone:'UTC'}), 'negative debit rejected');
rejects(() => parseKodikCostExport(csv.replace('2026-10-08','2026-02-30'),{format:'csv',naiveTimezone:'UTC'}), 'invalid export calendar date rejected');
rejects(() => parseKodikCostExport(csv.replace(';84;',';2147483648;'),{format:'csv',naiveTimezone:'UTC'}), 'overflowing token count rejected');
rejects(() => parseKodikCostExport(csv.replace('api_key_name','id'),{format:'csv',naiveTimezone:'UTC'}), 'duplicate or missing CSV header rejected');
rejects(() => parseKodikCostExport(csv.replace('NewReal Chat','"unclosed'),{format:'csv',naiveTimezone:'UTC'}), 'malformed CSV quoting rejected');
const quoted = parseKodikCostExport(csv.replace('NewReal Chat','"NewReal; Chat"'),{format:'csv',naiveTimezone:'UTC'});
check(quoted[0].api_key_name === 'NewReal; Chat', 'quoted semicolon remains in its column');
const sensitive = parseKodikCostExport(JSON.stringify([{...parsed[0],prompt:'secret_prompt',api_key:'secret_token'}]));
check(!JSON.stringify(sensitive).includes('secret_'), 'normalized export drops prompts and authentication fields');
const offset = parseKodikCostExport(JSON.stringify([{...parsed[0],timestamp:'2026-10-08T18:59:39+03:00'}]));
check(offset[0].timestamp === parsed[0].timestamp, 'explicit timestamp offsets preserve the instant');
console.log(`Cost input verification: ${checks} passed`);
