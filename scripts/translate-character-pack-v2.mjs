/** Two-stage public-catalog rollout. Dry run by default. No DB connection or implicit Yandex fallback. */
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync,renameSync,openSync,closeSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parse} from 'dotenv';
import {translateCharacterTwoStage,TRANSLATION_MODELS,TRANSLATION_POLICY_HASH,TRANSLATION_LOCALES,validateCharacterTranslation} from '../src/lib/characterTranslationPipeline.ts';
import {characterTranslationSource,characterTranslationHash} from '../src/lib/characterTranslationData.ts';
import {translationImportSql,applyReviewedCharacterFields} from './lib/localization-pack.mjs';
const options=new Map(process.argv.slice(2).map(v=>{const[k,...x]=v.replace(/^--/,'').split('=');return[k,x.join('=')||'true']}));
const apply=options.get('apply')==='true';
const directory=path.resolve(options.get('workdir')||'.runtime/localization-v2');mkdirSync(directory,{recursive:true});
const catalog=JSON.parse(readFileSync(options.get('catalog')||path.join(directory,'catalog-public-2026-10-29.json'),'utf8'));
const fields=['name','description','descriptionCard','appearance','greeting','scenario','exampleDialogs','avatarPrompt','publicMemory'];
const allowed=new Set(['id','isPublic',...fields]);
if(!Array.isArray(catalog)||new Set(catalog.map(r=>r.id)).size!==catalog.length||catalog.some(r=>!r.id||!/^[a-zA-Z0-9_-]+$/.test(r.id)||r.isPublic!==true||Object.keys(r).some(k=>!allowed.has(k))))throw new Error('Unique public-only catalog with approved fields required');
const locales=(options.get('locales')||TRANSLATION_LOCALES.join(',')).split(',');
if(new Set(locales).size!==locales.length||locales.some(l=>!TRANSLATION_LOCALES.includes(l)))throw new Error('Unsupported locales');
const jobs=catalog.flatMap(row=>locales.map(locale=>({row,locale,id:`${row.id}-${locale}`})));
const limit=Number(options.get('limit')||jobs.length),concurrency=Number(options.get('concurrency')||8);
if(!Number.isInteger(limit)||limit<1||!Number.isInteger(concurrency)||concurrency<1||concurrency>64)throw new Error('Invalid work bounds');
if(apply){
 const lock=path.join(directory,'writer.lock');
 if(existsSync(lock)){const pid=Number(readFileSync(lock,'utf8'));try{process.kill(pid,0);throw new Error('Catalog worker already active');}catch(error){if(error.code!=='ESRCH')throw error;unlinkSync(lock);}}
 closeSync(openSync(lock,'wx'));writeFileSync(lock,String(process.pid));
 process.once('exit',()=>{if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);});
}
const journal=path.join(directory,'usage.ndjson'),attempts=new Map();
if(existsSync(journal))for(const line of readFileSync(journal,'utf8').split('\n').filter(Boolean)){const event=JSON.parse(line);attempts.set(event.id,event);}
const cost=()=>[...attempts.values()].reduce((s,e)=>s+e.accountedUsd,0);
const append=event=>{appendFileSync(journal,JSON.stringify(event)+'\n');attempts.set(event.id,event);};
const safeWrite=(file,value)=>{writeFileSync(file+'.tmp',JSON.stringify(value));renameSync(file+'.tmp',file);};
const plan={version:2,policyHash:TRANSLATION_POLICY_HASH,publicCharacters:catalog.length,locales,variants:Math.min(limit,jobs.length),meanSourceCharacters:catalog.reduce((s,row)=>s+Object.values(characterTranslationSource(row)).reduce((n,t)=>n+(t?.length||0),0),0)/catalog.length,spentUpperUsd:cost(),provider:'deepinfra',models:TRANSLATION_MODELS,noYandexRequests:true};
writeFileSync(path.join(directory,'plan.json'),JSON.stringify(plan,null,2));console.log(JSON.stringify({dryRun:!apply,...plan}));
if(!apply)process.exit(0);
const budget=Number(options.get('max-total-usd')||0);
if(!(budget>0&&budget<=4.45))throw new Error('Explicit cumulative budget up to $4.45 required');
const config={...process.env};for(const file of ['.env','.env.local'])if(existsSync(file))Object.assign(config,parse(readFileSync(file)));
if(!config.DEEPINFRA_API_KEY)throw new Error('DeepInfra key missing');
const timeout=Number(options.get('timeout-ms')||240000);
if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>300000)throw new Error('Invalid provider timeout');
let nextRequestAt=0;
async function throttle(){const wait=Math.max(0,nextRequestAt-Date.now());nextRequestAt=Math.max(nextRequestAt,Date.now())+250;if(wait)await new Promise(resolve=>setTimeout(resolve,wait));}
let halted=false,cursor=0,completed=0,failed=0,cached=0,active=0;
let budgetWaiters=[];
const outcomes=[];
function progress(){safeWrite(path.join(directory,'progress.json'),{...plan,completed,failed,cached,processed:outcomes.length,planned:Math.min(limit,jobs.length),spentUpperUsd:cost(),running:!halted,updatedAt:new Date().toISOString()});}
async function processJob(job){
 const source=characterTranslationSource(job.row),sourceHash=characterTranslationHash(job.row);
 const output=path.join(directory,`${job.id}-result.json`);
 if(existsSync(output)){const old=JSON.parse(readFileSync(output,'utf8'));if(old.policyHash===TRANSLATION_POLICY_HASH&&old.sourceHash===sourceHash){try{validateCharacterTranslation(Object.fromEntries(fields.map(f=>[f,old[f]])),source,job.locale);cached++;return;}catch{renameSync(output,output+'.rejected-'+Date.now());}}}
 const checkpointFile=path.join(directory,`${job.id}-checkpoint.json`);
 const values=existsSync(checkpointFile)?JSON.parse(readFileSync(checkpointFile,'utf8')):{};
 const checkpoint={load:async key=>values[key],save:async(key,value)=>{values[key]=value;safeWrite(checkpointFile,values);}};
 const ask=async(stage,body)=>{
  await throttle();if(halted)throw new Error('rollout_halted');
  const rate=TRANSLATION_MODELS[stage],inputUpper=Buffer.byteLength(JSON.stringify(body),'utf8')+1024;
  const reservedUsd=(inputUpper*rate.input+body.max_tokens*rate.output)/1e6;
  while(cost()+reservedUsd>budget){if(!active){halted=true;throw new Error('rollout_budget_exhausted');}await new Promise(resolve=>budgetWaiters.push(resolve));if(halted)throw new Error('rollout_halted');}
  const entry={id:randomUUID(),jobId:job.id,locale:job.locale,stage,model:rate.id,policyHash:TRANSLATION_POLICY_HASH,startedAt:new Date().toISOString(),status:'reserved',accountedUsd:reservedUsd,reservedUsd};append(entry);
  active++;
  const started=Date.now();
  try{
   const response=await fetch('https://api.deepinfra.com/v1/openai/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${config.DEEPINFRA_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout),redirect:'error'});
   entry.httpStatus=response.status;entry.ms=Date.now()-started;
   const data=await response.json();
   if(!response.ok){if([400,401,402,403,404].includes(response.status))halted=true;if(response.status===429)nextRequestAt=Math.max(nextRequestAt,Date.now()+60000);throw new Error(`provider_http_${response.status}`);}
   const usage=data.usage;
   if(Number.isSafeInteger(usage?.prompt_tokens)&&usage.prompt_tokens>=0&&Number.isSafeInteger(usage?.completion_tokens)&&usage.completion_tokens>=0)Object.assign(entry,{inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens,accountedUsd:(usage.prompt_tokens*rate.input+usage.completion_tokens*rate.output)/1e6,usageConfirmed:true});
   entry.status='received';append(entry);
   if(data.choices?.[0]?.finish_reason!=='stop')throw new Error('provider_incomplete');
   const answer=JSON.parse(data.choices[0].message.content);entry.status='completed';append(entry);return answer;
  }catch(error){if(error instanceof TypeError&&!entry.httpStatus)halted=true;entry.status='failed';entry.ms=Date.now()-started;entry.error=error.name==='TimeoutError'?'provider_timeout':/^[a-z_0-9]+(?::[a-zA-Z]+)?$/.test(error.message)?error.message:'provider_or_response_error';append(entry);throw new Error(entry.error);}
  finally{active--;const waiting=budgetWaiters;budgetWaiters=[];for(const resolve of waiting)resolve();}
 };
 let translation=await translateCharacterTwoStage(job.row,job.locale,ask,checkpoint);
 const reviewFile=`scripts/data/${job.locale}-character-review.json`;
 if(existsSync(reviewFile)){
  const review=JSON.parse(readFileSync(reviewFile,'utf8'))[job.row.id];
  if(review?.fields&&review.sourceHash===sourceHash){const reviewed={characterId:job.row.id,sourceHash,...translation};applyReviewedCharacterFields(reviewed,review);translation=Object.fromEntries(fields.map(f=>[f,reviewed[f]]));validateCharacterTranslation(translation,source,job.locale);}
 }
 const record={characterId:job.row.id,locale:job.locale,sourceHash,policyHash:TRANSLATION_POLICY_HASH,...translation,source:Object.fromEntries(fields.map(f=>[f,job.row[f]??null]))};
 safeWrite(output,record);completed++;
}
async function worker(){while(cursor<Math.min(limit,jobs.length)&&!halted&&!existsSync(path.join(directory,'stop-after-current'))){const job=jobs[cursor++];try{await processJob(job);outcomes.push({id:job.id,ok:true});}catch(error){failed++;outcomes.push({id:job.id,ok:false,code:error.message});console.log(JSON.stringify(outcomes.at(-1)));}progress();if(outcomes.length%10===0)console.log(JSON.stringify({processed:outcomes.length,completed,cached,failed,spentUpperUsd:cost()}));}}
await Promise.all(Array.from({length:concurrency},worker));
for(const locale of locales){const records=catalog.flatMap(row=>{const file=path.join(directory,`${row.id}-${locale}-result.json`);if(!existsSync(file))return [];const r=JSON.parse(readFileSync(file,'utf8'));return r.policyHash===TRANSLATION_POLICY_HASH&&r.sourceHash===characterTranslationHash(row)?[r]:[];});if(records.length){safeWrite(path.join(directory,`${locale}-translations.json`),records);writeFileSync(path.join(directory,`import-${locale}.sql`),translationImportSql(records,fields,{pipelineHash:TRANSLATION_POLICY_HASH}));}}
halted=true;progress();safeWrite(path.join(directory,'outcomes.json'),outcomes);
console.log(JSON.stringify({finished:true,completed,cached,failed,spentUpperUsd:cost()}));if(failed||cursor<Math.min(limit,jobs.length))process.exitCode=1;
