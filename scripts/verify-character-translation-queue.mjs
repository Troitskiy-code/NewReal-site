import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {moduleLoader} from './lib/load-local-module.mjs';
const db=new PGlite();
const fields=['name','description','descriptionCard','appearance','greeting','scenario','exampleDialogs','avatarPrompt','publicMemory'];
const quoted=name=>'"'+name+'"';
async function raw(parts,...values){return db.query(parts.reduce((s,p,i)=>s+(i?'$'+i:'')+p,''),values);}
const client={$queryRaw:async(...args)=>(await raw(...args)).rows,$executeRaw:async(...args)=>(await raw(...args)).affectedRows};
client.$transaction=async fn=>fn(client);
client.character={
  findMany:async()=> (await db.query('SELECT id FROM "Character" WHERE "isPublic"=true')).rows,
  findUnique:async({where,select})=>{
    const row=(await db.query('SELECT * FROM "Character" WHERE id=$1',[where.id])).rows[0];
    if(row&&select.translations)row.translations=(await db.query('SELECT * FROM "CharacterTranslation" WHERE "characterId"=$1',[where.id])).rows;
    return row;
  },
};
client.characterTranslation={
  findUnique:async({where:{characterId_locale:k}})=>(await db.query('SELECT * FROM "CharacterTranslation" WHERE "characterId"=$1 AND locale=$2',[k.characterId,k.locale])).rows[0],
  upsert:async({create})=>{
    const keys=Object.keys(create),values=Object.values(create);
    return db.query(`INSERT INTO "CharacterTranslation" (${keys.map(quoted).join(',')},"updatedAt") VALUES (${values.map((_,i)=>'$'+(i+1)).join(',')},CURRENT_TIMESTAMP) ON CONFLICT ("characterId",locale) DO UPDATE SET ${keys.filter(k=>!['characterId','locale'].includes(k)).map(k=>`${quoted(k)}=EXCLUDED.${quoted(k)}`).join(',')}`,values);
  },
};
function jobWhere(where,values){
  const terms=[];
  for(const [key,value] of Object.entries(where)){
    values.push(value?.in||value);terms.push(`${quoted(key)}${value?.in?'=ANY':'='}($${values.length})`);
  }
  return terms.join(' AND ');
}
client.characterTranslationJob={
  createMany:async({data})=>{for(const row of data){const keys=Object.keys(row);await db.query(`INSERT INTO "CharacterTranslationJob" (${keys.map(quoted).join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')}) ON CONFLICT DO NOTHING`,Object.values(row));}},
  updateMany:async({where,data})=>{
    const values=[],set=Object.entries(data).map(([key,value])=>{
      const operation=value&&typeof value==='object'&&(Object.hasOwn(value,'increment')?'increment':Object.hasOwn(value,'decrement')?'decrement':null);
      values.push(operation?value[operation]:key==='checkpoint'?JSON.stringify(value):value);
      return `${quoted(key)}=${operation?quoted(key)+(operation==='increment'?'+':'-'):''}$${values.length}`;
    });
    return {count:(await db.query(`UPDATE "CharacterTranslationJob" SET ${set.join(',')} WHERE ${jobWhere(where,values)}`,values)).affectedRows};
  },
  findUniqueOrThrow:async({where})=>(await db.query('SELECT * FROM "CharacterTranslationJob" WHERE id=$1',[where.id])).rows[0],
  count:async({where})=>{const values=[];return (await db.query(`SELECT COUNT(*) AS count FROM "CharacterTranslationJob" WHERE ${jobWhere(where,values)}`,values)).rows[0].count;},
};
client.characterTranslationJob.update=({where,data})=>client.characterTranslationJob.updateMany({where,data});
client.characterTranslationBudget={
  upsert:async({where})=>db.query('INSERT INTO "CharacterTranslationBudget"(id) VALUES ($1) ON CONFLICT DO NOTHING',[where.id]),
  update:async({where,data})=>db.query('UPDATE "CharacterTranslationBudget" SET "usedUsd"="usedUsd"+$2 WHERE id=$1',[where.id,data.usedUsd.increment]),
};
const saved={key:process.env.DEEPINFRA_API_KEY,budget:process.env.CHARACTER_TRANSLATION_DAILY_BUDGET_USD,enabled:process.env.CHARACTER_TRANSLATION_ENABLED};
process.env.DEEPINFRA_API_KEY='synthetic-never-sent';process.env.CHARACTER_TRANSLATION_ENABLED='1';process.env.CHARACTER_TRANSLATION_DAILY_BUDGET_USD='1';
let calls=0,onRequest,slowDraft=false,stream={};
// Provider model. A non-streaming request is bounded by its client's TOTAL timeout (axios ECONNABORTED);
// a streaming one only needs chunks to keep arriving. SLOW_DRAFT_MS is generation time, as on prod 06–09.11.
const SLOW_DRAFT_MS=300000,usage={prompt_tokens:100,completion_tokens:50};
const generationMs=body=>slowDraft&&body.model.startsWith('Qwen/')?SLOW_DRAFT_MS:1000;
function answer(body){
  const original=JSON.parse(body.messages[1].content).original;
  return body.model.startsWith('Qwen/')?{...original,name:'Maren',description:'A merman.'}:{patches:[]};
}
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(signal.reason);
  const timer=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
});
/** SSE body in the DeepInfra shape: content deltas, a finish frame, a usage frame, [DONE]. */
function sseBody(text,init,onEnd,onChunk,{gapMs=0,pieces=6,finish='stop',stallAfter=-1,forever=false}={}){
  const frames=[],size=Math.ceil(text.length/pieces)||1;
  for(let i=0;i<text.length;i+=size)frames.push({choices:[{index:0,delta:{content:text.slice(i,i+size)}}]});
  frames.push({choices:[{index:0,delta:{},finish_reason:finish}]},{choices:[],usage});
  const encoder=new TextEncoder();let index=0;
  return new ReadableStream({async pull(controller){
    try{
      if(stallAfter===index)await sleep(3600000,init.signal);
      if(gapMs)await sleep(gapMs,init.signal);
      if(forever){onChunk?.();controller.enqueue(encoder.encode(': keep-alive\n\n'));return;}
      if(index>=frames.length){controller.enqueue(encoder.encode('data: [DONE]\n\n'));onEnd?.();controller.close();return;}
      onChunk?.();controller.enqueue(encoder.encode(`data: ${JSON.stringify(frames[index++])}\n\n`));
    }catch(error){onEnd?.();controller.error(error);}
  }});
}
const telemetry={
  meteredPost:async(_purpose,_url,body,config)=>{
    calls++;assert.ok(!JSON.stringify(body).includes('PRIVATE_SECRET'));await onRequest?.(body);
    if((config?.timeout||30000)<generationMs(body))throw Object.assign(new Error(`timeout of ${config?.timeout}ms exceeded`),{isAxiosError:true,code:'ECONNABORTED'});
    return {data:{usage,choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer(body))}}]}};
  },
  meteredChatFetch:async(url,init,model,_estimated,onEnd,onChunk,limits,purpose)=>{
    const body=JSON.parse(init.body);
    calls++;assert.ok(!JSON.stringify(body).includes('PRIVATE_SECRET'));await onRequest?.(body);
    assert.equal(url,'https://api.deepinfra.com/v1/openai/chat/completions');assert.equal(purpose,'translation','cost events stay labelled as translation');
    assert.equal(body.stream,true);assert.deepEqual(body.stream_options,{include_usage:true});assert.equal(model,body.model);
    assert.ok(limits.idleMs<limits.totalMs,'idle limit is shorter than the total limit');
    if(slowDraft)assert.ok(limits.totalMs>generationMs(body),'a generation that keeps streaming is not cut by the total limit');
    if(stream.firstByteStall)await sleep(3600000,init.signal);
    if(stream.status)return new Response('provider error body',{status:stream.status});
    return new Response(sseBody(stream.text??JSON.stringify(answer(body)),init,onEnd,onChunk,stream),{status:200});
  },
};
const load=moduleLoader({'src/lib/prisma.js':{prisma:client},'src/lib/i18nConfig.ts':{LOCALES:['ru','en','de']},'src/lib/aiCostTelemetry.ts':telemetry});
const queue=load('src/lib/characterTranslationQueue.ts');
const service=load('src/lib/characterTranslationService.ts');
try{
  await db.exec(`CREATE TABLE "Character"(id text PRIMARY KEY,"isPublic" boolean,${fields.map(f=>`${quoted(f)} ${f==='publicMemory'?'jsonb':'text'}`).join(',')},"privateMemory" text,${fields.map(f=>`${quoted(f+'_en')} ${f==='publicMemory'?'jsonb':'text'}`).join(',')});`);
  await db.exec(readFileSync('prisma/migrations/20261028120000_character_translations/migration.sql','utf8'));
  await db.exec(readFileSync('prisma/migrations/20261029140000_character_translation_pipeline/migration.sql','utf8'));
  await db.query('INSERT INTO "Character" (id,"isPublic",name,description,"privateMemory") VALUES ($1,true,$2,$3,$4),($5,false,$2,$3,$4)',['public','Марен','Русал.','PRIVATE_SECRET','private']);
  await queue.enqueueCharacterTranslations('private');assert.equal((await db.query('SELECT COUNT(*) AS count FROM "CharacterTranslationJob"')).rows[0].count,0);
  await queue.enqueueCharacterTranslations('public');await queue.enqueueCharacterTranslations('public');
  assert.equal((await db.query('SELECT COUNT(*) AS count FROM "CharacterTranslationJob"')).rows[0].count,2,'enqueue is idempotent');
  const results=await Promise.all([queue.processCharacterTranslationJob(),queue.processCharacterTranslationJob()]);
  assert.ok(results.every(r=>r.state==='complete'));assert.equal(calls,4,'concurrent claims process distinct jobs');
  assert.equal((await db.query('SELECT COUNT(*) AS count FROM "CharacterTranslation" WHERE "pipelineHash" IS NOT NULL')).rows[0].count,2);
  const used=(await db.query('SELECT "usedUsd" FROM "CharacterTranslationBudget"')).rows[0].usedUsd;assert.ok(used>0&&used<0.001,'reservations settle to confirmed usage');
  await db.exec('DELETE FROM "CharacterTranslation"; UPDATE "CharacterTranslationJob" SET state=\'queued\',attempts=0');
  process.env.CHARACTER_TRANSLATION_DAILY_BUDGET_USD='0.000001';
  const budget=await queue.processCharacterTranslationJob();assert.equal(budget.code,'translation_daily_budget');assert.equal(calls,4,'no request after shared daily ceiling');
  assert.equal((await db.query('SELECT attempts FROM "CharacterTranslationJob" WHERE state=\'retry\'')).rows[0].attempts,0);
  process.env.CHARACTER_TRANSLATION_DAILY_BUDGET_USD='1';
  await db.exec('UPDATE "CharacterTranslationJob" SET state=\'queued\',attempts=0,"nextAttemptAt"=CURRENT_TIMESTAMP');
  onRequest=async body=>{if(body.model.startsWith('Qwen/'))await db.exec('UPDATE "Character" SET description=\'Изменено\' WHERE id=\'public\'');};
  const stale=await queue.processCharacterTranslationJob();assert.equal(stale.state,'cancelled');assert.equal((await db.query('SELECT COUNT(*) AS count FROM "CharacterTranslation"')).rows[0].count,0,'source edits prevent stale publication');
  onRequest=async()=>{throw new Error('synthetic provider failure');};
  await db.exec('UPDATE "Character" SET description=\'Русал.\' WHERE id=\'public\'; UPDATE "CharacterTranslationJob" SET state=\'queued\',attempts=0,checkpoint=\'{}\'');
  for(let attempt=0;attempt<6;attempt++){
    await db.exec('UPDATE "CharacterTranslationJob" SET "nextAttemptAt"=CURRENT_TIMESTAMP WHERE state IN (\'queued\',\'retry\')');
    await queue.processCharacterTranslationJob();
  }
  assert.ok((await db.query('SELECT COUNT(*) AS count FROM "CharacterTranslationJob" WHERE state=\'failed\'')).rows[0].count>=1,'paid retries terminate');
  await db.exec('UPDATE "CharacterTranslationJob" SET state=\'processing\',attempts=3,"leaseUntil"=CURRENT_TIMESTAMP-INTERVAL \'1 minute\'');
  await queue.processCharacterTranslationJob();assert.equal((await db.query('SELECT COUNT(*) AS count FROM "CharacterTranslationJob" WHERE state=\'processing\'')).rows[0].count,0,'expired terminal leases do not stick');
  // Prod 06–09.11: 31 drafts cut at exactly 240 s. A slow draft that keeps streaming must complete.
  await db.exec('DELETE FROM "CharacterTranslation"; UPDATE "CharacterTranslationJob" SET state=\'queued\',attempts=0,checkpoint=\'{}\',"errorCode"=NULL,"nextAttemptAt"=CURRENT_TIMESTAMP,"leaseToken"=NULL,"leaseUntil"=NULL');
  slowDraft=true;
  // The draft shortens the lease; the review must find it renewed, so a long job is not claimed twice.
  onRequest=async body=>{if(body.model.startsWith('Qwen/'))await db.exec('UPDATE "CharacterTranslationJob" SET "leaseUntil"=CURRENT_TIMESTAMP+INTERVAL \'1 minute\' WHERE state=\'processing\'');
    else assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM "CharacterTranslationJob" WHERE state=\'processing\' AND "leaseUntil">CURRENT_TIMESTAMP+INTERVAL \'19 minutes\'')).rows[0].count),1,'each paid call renews the lease');};
  const slow=await queue.processCharacterTranslationJob();
  assert.equal(slow.state,'complete',`a ${SLOW_DRAFT_MS/1000}-second streamed draft completes (got ${slow.code})`);
  slowDraft=false;onRequest=undefined;
  // Direct transport checks with short limits: stalls fail fast, live streams continue past the idle limit.
  const request={model:'Qwen/Qwen3-235B-A22B-Instruct-2507',messages:[{role:'system',content:'s'},{role:'user',content:JSON.stringify({original:{name:'Марен'}})}],max_tokens:100,temperature:0,stream:false,response_format:{}};
  const limits={firstByteMs:150,idleMs:60,totalMs:1500};
  const code=async(promise)=>{try{await promise;return 'resolved';}catch(error){return error.code||error.message;}};
  let settled=[];const settle=async u=>{settled.push(u);};
  stream={gapMs:20,pieces:20};
  assert.deepEqual(await service.requestCharacterTranslation(request,settle,limits),{name:'Maren',description:'A merman.'},'chunks every 20 ms for ~450 ms pass a 60 ms idle limit');
  assert.deepEqual(settled,[usage],'streamed usage settles the reservation');
  stream={stallAfter:2};let started=Date.now();
  assert.equal(await code(service.requestCharacterTranslation(request,settle,limits)),'translation_timeout:idle');assert.ok(Date.now()-started<1000,'a stalled stream fails on the idle limit');
  stream={firstByteStall:true};
  assert.equal(await code(service.requestCharacterTranslation(request,settle,limits)),'translation_timeout:first_byte');
  stream={forever:true,gapMs:20};started=Date.now();
  assert.equal(await code(service.requestCharacterTranslation(request,settle,{...limits,totalMs:300})),'translation_timeout:total');assert.ok(Date.now()-started<1000);
  settled=[];stream={finish:'length'};
  assert.equal(await code(service.requestCharacterTranslation(request,settle,limits)),'translation_incomplete','a cut answer is never parsed');
  assert.deepEqual(settled,[usage],'usage of a cut answer is still settled');
  stream={status:503};
  assert.equal(await code(service.requestCharacterTranslation(request,settle,limits)),'translation_provider_failed');
  stream={text:'{"name":'};
  assert.equal(await code(service.requestCharacterTranslation(request,settle,limits)),'translation_invalid_json');
  stream={};
  console.log('PASS translation queue: actual PostgreSQL claims, public-only inputs, idempotence, shared cost reservations, source races, bounded retries, expired leases, streamed drafts past 240 s, lease renewal and stream timeouts');
}finally{await db.close();for(const [key,value]of Object.entries({DEEPINFRA_API_KEY:saved.key,CHARACTER_TRANSLATION_DAILY_BUDGET_USD:saved.budget,CHARACTER_TRANSLATION_ENABLED:saved.enabled}))if(value===undefined)delete process.env[key];else process.env[key]=value;}
