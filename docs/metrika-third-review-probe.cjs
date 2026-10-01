// Positive regression expectations for the four findings of the second review.
// Reuse its isolated runtime fixture, not its assertions about old defects.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const fixture=fs.readFileSync(path.join(__dirname,'metrika-second-review-probe.cjs'),'utf8').split('async function main()')[0];
const {context,storage,record,clock,key,flush}=new Function('require','__dirname',fixture+
  '\nreturn {context,storage,record,clock,key,flush};')(require,__dirname);
async function main(){
  const results={};
  const local=storage(),session=storage();local.setItem=()=>{throw new Error('QuotaExceededError');};
  let fetches=0,calls=0;
  const degraded=context({local,session,
    fetcher:async()=>{fetches++;return{status:200,ok:true,json:async()=>({status:'confirmed',kind:'purchase',amountRub:129})};},
    dispatch:async()=>{calls++;return{status:'callback_completed'};}});
  degraded.win.location={href:'http://localhost/ru/coins?InvId=301',search:'?InvId=301'};
  degraded.api.captureInvoiceFromUrl();
  const confirmed=await degraded.api.pollAndDispatchInvoice('301');
  assert.equal(fetches,1);assert.equal(calls,1);assert.equal(confirmed.confirmed,true);
  await degraded.api.pollAndDispatchInvoice('301');
  const reloaded=context({local,session,dispatch:async()=>{calls++;return{status:'callback_completed'};}});
  await reloaded.api.pollAndDispatchInvoice('301');
  assert.equal(calls,1);
  assert.equal(reloaded.api.resolveBannerRecord().invoiceId,'301');
  results.totalLocalWriteFailure={statusRequested:true,goalCalls:calls,reloadRetainsCompletedGoal:true};

  const stale=storage(),latest=storage();
  stale.setItem(key,JSON.stringify([record('302',{confirmed:true,kind:'purchase',
    goals:{vc_purchase_success:{state:'dispatched',attempts:1,updatedAt:clock.now}}})]));
  latest.setItem(key,JSON.stringify([record('302',{confirmed:true,kind:'purchase',updatedAt:clock.now+1,
    goals:{vc_purchase_success:{state:'timeout',attempts:2,updatedAt:clock.now+1}}})]));
  const originalSet=stale.setItem;
  stale.setItem=(k,v)=>{if(k===key)throw new Error('QuotaExceededError');originalSet(k,v);};
  let retries=0;
  const capped=context({local:stale,session:latest,dispatch:async()=>{retries++;return{status:'timeout'};}});
  for(let i=0;i<5;i++){clock.now++;await capped.api.pollAndDispatchInvoice('302');}
  assert.equal(retries,1);assert.equal(capped.api.listPendingPurchases()[0].goals.vc_purchase_success.attempts,3);
  const afterReload=context({local:stale,session:latest,dispatch:async()=>{retries++;return{status:'timeout'};}});
  await afterReload.api.pollAndDispatchInvoice('302');
  assert.equal(retries,1);assert.equal(afterReload.api.shouldContinuePolling(afterReload.api.listPendingPurchases()[0]),false);
  results.staleDispatchedRetryCap={additionalCalls:retries,attempts:3,reloadDoesNotRetry:true};

  for(const mode of ['response','rejection','json']){
    let release,reject,releaseJson;
    const switching=context({fetcher:mode==='json'
      ?async()=>({status:200,ok:true,json:()=>new Promise(r=>{releaseJson=r;})})
      :()=>new Promise((r,j)=>{release=r;reject=j;})});
    const pending=switching.api.pollAndDispatchInvoice('303');await flush();
    switching.api.setPurchaseTrackerUser(null);switching.api.setPurchaseTrackerUser('user-B');
    if(mode==='response')release({status:200,ok:true,json:async()=>({status:'confirmed',kind:'purchase'})});
    else if(mode==='rejection')reject(new Error('synthetic offline'));
    else releaseJson({status:'confirmed',kind:'purchase'});
    await pending;
    assert.equal(switching.api.listPendingPurchases().length,0);
    assert.equal(switching.local.getItem('nv-metrika-pending:999001:user-B'),null);
  }
  results.accountSwitch={lateFetchWrites:false,lateJsonWrites:false,lateFailureWrites:false};

  const durable=storage(),tabSession=storage();const prior=context({local:durable,session:tabSession});
  prior.win.location={href:'http://localhost/ru/coins?InvId=304',search:'?InvId=304'};
  prior.api.captureInvoiceFromUrl();await prior.api.pollAndDispatchInvoice('304');
  const sameTab=context({local:durable,session:tabSession});
  assert.equal(sameTab.api.resolveBannerRecord().invoiceId,'304');
  const otherTab=context({local:durable});assert.equal(otherTab.api.resolveBannerRecord(),null);
  sameTab.api.setPurchaseTrackerUser(null);sameTab.api.setPurchaseTrackerUser('user-A');
  assert.equal(sameTab.api.resolveBannerRecord(),null);
  results.bannerSession={sameTabReloadRestores:true,newTabBanner:false,logoutLoginBanner:false};

  let releaseFirst;let concurrentFetches=0;
  const busyLocal=storage();busyLocal.setItem=()=>{throw new Error('QuotaExceededError');};
  const oneTab=context({local:busyLocal,fetcher:()=>{concurrentFetches++;return new Promise(r=>{releaseFirst=r;});}});
  const first=oneTab.api.pollAndDispatchInvoice('305');await flush();
  assert.equal(await oneTab.api.pollAndDispatchInvoice('305'),null);
  assert.equal(concurrentFetches,1);
  releaseFirst({status:200,ok:true,json:async()=>({status:'confirmed',kind:'purchase'})});await first;
  results.inTabLock={concurrentStatusRequests:concurrentFetches};
  const output={productionUsed:false,networkUsed:false,allSecondReviewFixesVerified:true,results};
  fs.writeFileSync(path.join(__dirname,'metrika-third-review-probe.json'),JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify(output,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
