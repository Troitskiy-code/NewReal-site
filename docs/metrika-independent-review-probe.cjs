// Independent review: real runtime/hooks, mocked browser storage, API and Yandex.
// No production database, payments, credentials or network requests.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const key = 'nv-metrika-pending:999001';
const now = { value: 1000000 };
const calls = [];
const flush = () => new Promise(resolve => setImmediate(resolve));
const storage = () => {
  const items = new Map();
  return {
    getItem: k => items.get(k) ?? null,
    setItem: (k,v) => items.set(k, String(v)),
    removeItem: k => items.delete(k),
  };
};
function record(invoiceId, confirmed = false) {
  return {invoiceId, userId:'user-A', createdAt:now.value, pollAttempts:0,
    lastPollAt:0, kind:confirmed?'purchase':null, planId:null, amountRub:129,
    confirmed, goals:{}};
}
function compile(file, mocks, globals) {
  const mod = {exports:{}};
  const js = ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022,
      jsx:ts.JsxEmit.ReactJSX}, fileName:file,
  }).outputText;
  vm.runInNewContext(js, {...globals, exports:mod.exports, module:mod,
    require:id => { if (!(id in mocks)) throw new Error('Unexpected import: '+id); return mocks[id]; },
    console, URL, URLSearchParams, Date:class extends Date {static now(){return now.value;}},
    setTimeout, clearTimeout}, {filename:file, timeout:5000});
  return mod.exports;
}
function runtime({local=storage(), session=storage(), ready=()=>true,
  wait=async()=>true, dispatch=async()=>({status:'callback_completed'}),
  status=()=>({status:'confirmed', kind:'purchase', amountRub:129})}={}) {
  const win = {localStorage:local, sessionStorage:session,
    location:{href:'http://localhost/ru/coins',search:''},
    history:{replaceState(){}}, setTimeout, clearTimeout};
  const api = compile('src/lib/purchaseGoalRuntime.ts', {
    './paymentStatus':{normalizeInvId:v => /^\d+$/.test(v||'')?v:null},
    './metrika':{METRIKA_COUNTER_ID:999001,
      METRIKA_GOALS:{vcPurchaseSuccess:'vc_purchase_success',subscriptionSuccess:'subscription_success'},
      metrikaPlanSlug:v=>v, subscriptionGoal:v=>v, dispatchGoal:dispatch},
    './metrikaLoader':{isMetrikaCounterReady:ready,waitForMetrika:wait},
  }, {window:win,navigator:{},fetch:async()=>({status:200,ok:true,json:async()=>status()})});
  api.setPurchaseTrackerUser('user-A');
  return {api,win,local,session};
}
async function main() {
  const results = {};
  // A previously readable localStorage value masks newer sessionStorage progress
  // when localStorage writes start failing (quota, permission change).
  const local=storage(), session=storage();
  local.setItem(key,JSON.stringify([record('201')]));
  const set = local.setItem;
  local.setItem=(k,v)=>{if(k===key)throw new Error('QuotaExceededError');set(k,v);};
  let deliveries=0;
  const partial=runtime({local,session,dispatch:async()=>{deliveries++;return {status:'callback_completed'};}});
  await partial.api.pollAndDispatchInvoice('201');
  await partial.api.pollAndDispatchInvoice('201');
  assert.equal(deliveries,2);
  results.partialStorageFailure={goalDeliveries:deliveries,
    persistedSessionState:JSON.parse(session.getItem(key))[0].goals.vc_purchase_success.state,
    readState:partial.api.listPendingPurchases()[0].goals.vc_purchase_success?.state??'missing'};

  // Cross-account replay keeps confirmed=true even when the current user's API
  // explicitly returns pending. No purchase goal is sent in this scenario.
  const accounts=runtime({status:()=>({status:'pending',invId:'202'})});
  accounts.api.upsertPendingPurchase(record('202',true));
  accounts.api.setPurchaseTrackerUser('user-B');
  accounts.win.location={href:'http://localhost/ru/coins?InvId=202',search:'?InvId=202'};
  accounts.api.captureInvoiceFromUrl();
  const rebound=await accounts.api.pollAndDispatchInvoice('202');
  assert.equal(rebound.userId,'user-B');
  assert.equal(accounts.api.confirmationStatusOf(rebound),'confirmed');
  results.accountSwitch={serverStatus:'pending',clientStatus:'confirmed',recordOwner:rebound.userId};

  // Execute the actual confirmation hook with deterministic React hook stubs.
  // Old confirmed invoice remains selected after a new pending invoice is emitted.
  const bannerRuntime=runtime();
  bannerRuntime.api.upsertPendingPurchase(record('203',true));
  let state, subscriber; const effects=[];
  const hook=compile('src/components/PurchaseStatusBanner.tsx', {
    'react':{useState:initial=>{if(state===undefined)state=initial();return[state,f=>{state=typeof f==='function'?f(state):f;}];},
      useEffect:f=>effects.push(f)},
    'react/jsx-runtime':{},'next-auth/react':{useSession:()=>({status:'authenticated'})},
    'react-i18next':{useTranslation:()=>({t:k=>k})},
    '@/lib/purchaseGoalRuntime':{...bannerRuntime.api,
      captureInvoiceFromUrl:()=>null,subscribePurchaseRecord:f=>{subscriber=f;return()=>{};}},
  }, {window:bannerRuntime.win});
  hook.usePurchaseConfirmation(); effects.shift()();
  subscriber(record('204',false));
  const displayed=hook.usePurchaseConfirmation();
  assert.equal(displayed.invId,'203');assert.equal(displayed.status,'confirmed');
  results.newInvoiceBanner={newInvoice:'204',newInvoiceStatus:'pending',displayed};

  // Two independent runtime instances (tabs) share localStorage but no Web Locks.
  // First waits 11.5s for readiness, then waits for a callback (still within 8s).
  // At t=16s the 15s storage lease expires and the second tab sends the same goal.
  const shared=storage(); let readiness=false,releaseReady,releaseCallback;
  now.value=2000000;
  const first=runtime({local:shared,ready:()=>readiness,
    wait:()=>new Promise(r=>{releaseReady=r;}),
    dispatch:()=>{calls.push('tab-1');return new Promise(r=>{releaseCallback=r;});}});
  const second=runtime({local:shared,ready:()=>true,
    dispatch:async()=>{calls.push('tab-2');return {status:'callback_completed'};}});
  first.api.upsertPendingPurchase(record('205'));
  const inFlight=first.api.pollAndDispatchInvoice('205');await flush();
  now.value+=11500;readiness=true;releaseReady(true);await flush();
  now.value+=4500;
  await second.api.pollAndDispatchInvoice('205');
  assert.deepEqual(calls,['tab-1','tab-2']);
  releaseCallback({status:'callback_completed'});await inFlight;
  results.storageLease={goalDeliveries:calls.length,
    firstCallbackWaitMs:4500,callbackTimeoutMs:8000,timeoutOccurred:false};

  const output={productionUsed:false,networkUsed:false,reproducedRegressions:results};
  fs.writeFileSync(path.join(__dirname,'metrika-independent-review-probe.json'),JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify(output,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
