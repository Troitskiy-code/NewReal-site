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
let calls=0,onRequest;
const load=moduleLoader({'src/lib/prisma.js':{prisma:client},'src/lib/i18nConfig.ts':{LOCALES:['ru','en','de']},'src/lib/aiCostTelemetry.ts':{meteredPost:async(_purpose,_url,body)=>{
  calls++;assert.ok(!JSON.stringify(body).includes('PRIVATE_SECRET'));await onRequest?.(body);
  const original=JSON.parse(body.messages[1].content).original;
  const result=body.model.startsWith('Qwen/')?{...original,name:'Maren',description:'A merman.'}:{patches:[]};
  return {data:{usage:{prompt_tokens:100,completion_tokens:50},choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}};
}}});
const queue=load('src/lib/characterTranslationQueue.ts');
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
  console.log('PASS translation queue: actual PostgreSQL claims, public-only inputs, idempotence, shared cost reservations, source races, bounded retries and expired leases');
}finally{await db.close();for(const [key,value]of Object.entries({DEEPINFRA_API_KEY:saved.key,CHARACTER_TRANSLATION_DAILY_BUDGET_USD:saved.budget,CHARACTER_TRANSLATION_ENABLED:saved.enabled}))if(value===undefined)delete process.env[key];else process.env[key]=value;}
