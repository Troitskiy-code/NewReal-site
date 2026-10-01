// Real purchase runtime in independent VM contexts. All API/Yandex/storage mocked.
// No credentials, production database, payments or network requests.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = ts.transpileModule(fs.readFileSync(path.join(root,'src/lib/purchaseGoalRuntime.ts'),'utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
const clock = {now:1000000};
const key = 'nv-metrika-pending:999001:user-A';
const flush = () => new Promise(r=>setTimeout(r,30));
function storage() {
  const map=new Map();
  return {get length(){return map.size;},key:i=>[...map.keys()][i]??null,
    getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};
}
function record(invoiceId, patch={}) {
  return {invoiceId,userId:'user-A',createdAt:clock.now,updatedAt:clock.now,
    pollAttempts:0,lastPollAt:0,kind:null,planId:null,amountRub:null,
    confirmed:false,bannerSession:false,goals:{},...patch};
}
function context({local=storage(),session=storage(),ready=()=>true,wait=async()=>true,
  dispatch=async()=>({status:'callback_completed'}),
  fetcher=async()=>({status:200,ok:true,json:async()=>({status:'confirmed',kind:'purchase',amountRub:129})})}={}) {
  const intervals=new Set();
  const win={localStorage:local,sessionStorage:session,setTimeout,clearTimeout,
    setInterval:f=>{intervals.add(f);return f;},clearInterval:f=>intervals.delete(f),
    location:{href:'http://localhost/ru/coins',search:''},
    history:{replaceState(_s,_t,url){const next=new URL(url,'http://localhost');win.location={href:next.href,search:next.search};}}};
  const mocks={
    './paymentStatus':{normalizeInvId:v=>/^\d+$/.test(v||'')?v:null},
    './metrika':{METRIKA_COUNTER_ID:999001,METRIKA_GOALS:{vcPurchaseSuccess:'vc_purchase_success',subscriptionSuccess:'subscription_success'},
      dispatchGoal:dispatch,metrikaPlanSlug:v=>v,subscriptionGoal:v=>'subscription_'+v},
    './metrikaLoader':{isMetrikaCounterReady:ready,waitForMetrika:wait},
  };
  const mod={exports:{}};
  vm.runInNewContext(source,{module:mod,exports:mod.exports,
    require:id=>{if(!(id in mocks))throw new Error('Unexpected import '+id);return mocks[id];},
    window:win,navigator:{},fetch:fetcher,URL,URLSearchParams,console,
    Date:class extends Date {static now(){return clock.now;}},setTimeout,clearTimeout,
    setInterval:win.setInterval,clearInterval:win.clearInterval},
    {filename:'src/lib/purchaseGoalRuntime.ts',timeout:5000});
  mod.exports.setPurchaseTrackerUser('user-A');
  mod.exports.setPurchaseGoalRuntimeForTests({retryDelayMs:0,disableWebLocks:true});
  return {api:mod.exports,win,local,session,pulse:()=>{for(const f of intervals)f();}};
}
async function main() {
  const fixes={},gaps={};
  // Correctly scoped key, current record shape, real fallback interval APIs.
  const local=storage(),session=storage();let completedCalls=0;
  local.setItem(key,JSON.stringify([record('201')]));
  const realSet=local.setItem;
  local.setItem=(k,v)=>{if(k===key)throw new Error('QuotaExceededError');realSet(k,v);};
  const partial=context({local,session,dispatch:async()=>{completedCalls++;return{status:'callback_completed'};}});
  await partial.api.pollAndDispatchInvoice('201');await partial.api.pollAndDispatchInvoice('201');
  assert.equal(completedCalls,1);
  fixes.completedGoalAfterPartialStorageFailure={calls:completedCalls,state:partial.api.listPendingPurchases()[0].goals.vc_purchase_success.state};

  const banner=context();
  banner.api.upsertPendingPurchase(record('203',{confirmed:true,kind:'purchase'}));
  banner.win.location={href:'http://localhost/ru/coins?InvId=204',search:'?InvId=204'};
  banner.api.captureInvoiceFromUrl();
  assert.equal(banner.api.resolveBannerRecord().invoiceId,'204');
  assert.equal(banner.api.resolveBannerRecord().confirmed,false);
  banner.api.setPurchaseTrackerUser('user-B');
  assert.equal(banner.api.listPendingPurchases().length,0);
  fixes.newInvoiceAndAccountScope={invoice:'204',confirmed:false,otherUserRecords:0};

  const shared=storage();let releaseReady,releaseGoal;const owners=[];
  const first=context({local:shared,ready:()=>false,wait:()=>new Promise(r=>{releaseReady=r;}),
    dispatch:()=>{owners.push('tab-1');return new Promise(r=>{releaseGoal=r;});}});
  const second=context({local:shared,dispatch:async()=>{owners.push('tab-2');return{status:'callback_completed'};}});
  first.api.setPurchaseGoalRuntimeForTests({ownerId:'tab-1',lockTtlMs:15000});
  second.api.setPurchaseGoalRuntimeForTests({ownerId:'tab-2',lockTtlMs:15000});
  const pending=first.api.pollAndDispatchInvoice('205');await flush();
  clock.now+=5000;first.pulse();clock.now+=5000;first.pulse();
  clock.now+=1500;releaseReady(true);await flush();
  clock.now+=4500;first.pulse();
  assert.equal(await second.api.pollAndDispatchInvoice('205'),null);
  releaseGoal({status:'callback_completed'});await pending;
  assert.deepEqual(owners,['tab-1']);
  fixes.leaseBeyondOriginalExpiry={calls:owners.length,elapsedMs:16000};

  // Actual quota failure applies to every localStorage setItem, including lease.
  const failedLocal=storage();failedLocal.setItem=()=>{throw new Error('QuotaExceededError');};
  let fetches=0,goalCalls=0;
  const denied=context({local:failedLocal,
    fetcher:async()=>{fetches++;return{status:200,ok:true,json:async()=>({status:'confirmed',kind:'purchase'})};},
    dispatch:async()=>{goalCalls++;return{status:'callback_completed'};}});
  denied.win.location={href:'http://localhost/ru/coins?InvId=301',search:'?InvId=301'};
  denied.api.captureInvoiceFromUrl();
  const deniedResult=await denied.api.pollAndDispatchInvoice('301');
  assert.equal(fetches,0);assert.equal(goalCalls,0);assert.equal(deniedResult,null);
  gaps.completeLocalStorageFailure={sessionPersisted:Boolean(denied.session.getItem(key)),
    urlSearch:denied.win.location.search,statusRequests:fetches,goalCalls,result:deniedResult};

  // An older dispatched snapshot outranks a newer timeout snapshot. Failed local
  // writes keep attempts=1 forever, so the documented three-attempt cap is lost.
  const stale=storage(),latest=storage();
  const staleRow=record('302',{confirmed:true,kind:'purchase',
    goals:{vc_purchase_success:{state:'dispatched',attempts:1,updatedAt:clock.now}}});
  const newRow=record('302',{confirmed:true,kind:'purchase',updatedAt:clock.now+1,
    goals:{vc_purchase_success:{state:'timeout',attempts:2,updatedAt:clock.now+1}}});
  stale.setItem(key,JSON.stringify([staleRow]));latest.setItem(key,JSON.stringify([newRow]));
  const staleSet=stale.setItem;
  stale.setItem=(k,v)=>{if(k===key)throw new Error('QuotaExceededError');staleSet(k,v);};
  let timeoutCalls=0;
  const timeouts=context({local:stale,session:latest,dispatch:async()=>{timeoutCalls++;return{status:'timeout'};}});
  for(let i=0;i<5;i++){clock.now++;await timeouts.api.pollAndDispatchInvoice('302');}
  assert.equal(timeoutCalls,5);
  gaps.retryBudgetLost={additionalCalls:timeoutCalls,readAttempts:timeouts.api.listPendingPurchases()[0].goals.vc_purchase_success.attempts,
    sessionAttempts:JSON.parse(latest.getItem(key))[0].goals.vc_purchase_success.attempts,maxAttempts:3};

  // A request belonging to A must not write into B's scoped storage after logout.
  let releaseFetch;
  const switching=context({fetcher:()=>new Promise(r=>{releaseFetch=r;})});
  const oldRequest=switching.api.pollAndDispatchInvoice('303');await flush();
  switching.api.setPurchaseTrackerUser(null);switching.api.setPurchaseTrackerUser('user-B');
  releaseFetch({status:200,ok:true,json:async()=>({status:'confirmed',kind:'purchase'})});
  await oldRequest;
  const foreign=switching.api.listPendingPurchases().find(r=>r.invoiceId==='303');
  assert.equal(foreign.userId,'user-A');
  gaps.staleRequestWritesNewAccount={currentAccount:'user-B',storedOwner:foreign.userId,
    storedInNewAccount:Boolean(switching.local.getItem('nv-metrika-pending:999001:user-B'))};

  // Banner session flag survives an actual reload (new runtime instance).
  const persisted=storage();const prior=context({local:persisted});
  prior.win.location={href:'http://localhost/ru/coins?InvId=304',search:'?InvId=304'};
  prior.api.captureInvoiceFromUrl();await prior.api.pollAndDispatchInvoice('304');
  const reloaded=context({local:persisted});
  assert.equal(reloaded.api.resolveBannerRecord().confirmed,true);
  gaps.bannerResurrectsWithoutReturn={urlSearch:reloaded.win.location.search,
    invoice:reloaded.api.resolveBannerRecord().invoiceId,status:'confirmed'};

  const output={productionUsed:false,networkUsed:false,previousFixesVerified:fixes,remainingGaps:gaps};
  fs.writeFileSync(path.join(__dirname,'metrika-second-review-probe.json'),JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify(output,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
