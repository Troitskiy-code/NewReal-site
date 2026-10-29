import assert from 'node:assert/strict';
import {NextRequest} from 'next/server.js';
import {moduleLoader} from './lib/load-local-module.mjs';
import {startCharacterTranslationWorker} from './lib/character-translation-worker.mjs';
const saved=process.env.CRON_SECRET;
process.env.CRON_SECRET='synthetic-translation-worker';
let processed=0,statusReads=0,contexts=0;
try{
  const route=moduleLoader({
    '@/lib/characterTranslationQueue':{characterTranslationStatus:async()=>{statusReads++;return {enabled:true};},processCharacterTranslationJob:async()=>{processed++;return {processed:1};}},
    '@/lib/aiCostTelemetry':{withAiCostContext:fn=>{contexts++;return fn();}},
    '@/lib/logger':{errorLog(){},toSafeDiagnostic:()=>({})},
  })('src/app/api/cron/translate-characters/route.ts');
  const req=headers=>new NextRequest('http://127.0.0.1:3000/api/cron/translate-characters',{headers});
  assert.equal((await route.POST(req({}))).status,401);
  assert.equal((await route.POST(req({Authorization:'Bearer wrong'}))).status,401);
  assert.equal(processed,0);
  const headers={Authorization:'Bearer synthetic-translation-worker'};
  assert.equal((await route.GET(req(headers))).status,200);
  assert.equal(statusReads,1);assert.equal(processed,0,'status reads never start paid work');
  assert.equal((await route.POST(req(headers))).status,200);
  assert.equal(processed,1);assert.equal(contexts,1);
  let worker,calls=0;
  await new Promise((resolve,reject)=>{
    const guard=setTimeout(()=>{worker?.stop();reject(new Error('Worker did not poll'));},1000);
    worker=startCharacterTranslationWorker({port:3051,secret:'synthetic-translation-worker',intervalMs:1,fetchImpl:async(url,init)=>{
      calls++;assert.equal(url,'http://127.0.0.1:3051/api/cron/translate-characters');assert.equal(init.method,'POST');
      assert.equal(init.headers.Authorization,'Bearer synthetic-translation-worker');assert.equal(init.redirect,'error');
      worker.stop();clearTimeout(guard);resolve();return new Response(null,{status:204});
    }});
  });
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls,1,'stopped poller cannot start another job');
  startCharacterTranslationWorker({secret:'',fetchImpl:async()=>{throw new Error('disabled worker made a request');}}).stop();
  startCharacterTranslationWorker({port:'3000@external.invalid',secret:'synthetic',fetchImpl:async()=>{throw new Error('invalid loopback port');}}).stop();
  console.log('PASS translation worker: authenticated loopback only, read-only status, one processing call, cost context, stop and disabled configuration');
}finally{if(saved===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=saved;}
