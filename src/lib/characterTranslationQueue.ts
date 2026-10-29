import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { LOCALES } from "./i18nConfig";
import { CHARACTER_TRANSLATION_FIELDS } from "./characterLocalization";
import { characterTranslationHash, characterTranslationSourceSelect, type TranslationSource } from "./characterTranslationData";
import { CharacterTranslationError, TRANSLATION_MODELS, TRANSLATION_POLICY_HASH, type TranslationRequest, type TranslationStage } from "./characterTranslationPipeline";
import { translateCharacterContent, requestCharacterTranslation } from "./characterTranslationService";
import { memoryToText } from "./persistentMemory";

export const characterTranslationEnabled=()=>!!process.env.DEEPINFRA_API_KEY&&process.env.CHARACTER_TRANSLATION_ENABLED!=="0";
const identity=(id:string,locale:string,hash:string)=>createHash("sha256").update(JSON.stringify([id,locale,hash,TRANSLATION_POLICY_HASH])).digest("hex");
export async function enqueueCharacterTranslations(characterId:string) {
  if(!characterTranslationEnabled())return;
  const row=await prisma.character.findUnique({where:{id:characterId},select:{...characterTranslationSourceSelect,translations:{select:{locale:true,sourceHash:true,pipelineHash:true}}}});
  if(!row?.isPublic)return;
  const sourceHash=characterTranslationHash(row);
  const targets=LOCALES.filter(locale=>locale!=="ru"&&!row.translations.some(t=>t.locale===locale&&t.sourceHash===sourceHash&&[TRANSLATION_POLICY_HASH,"manual"].includes(t.pipelineHash||"")));
  if(targets.length){
    const data=targets.map(locale=>({id:identity(row.id,locale,sourceHash),characterId:row.id,locale,sourceHash,policyHash:TRANSLATION_POLICY_HASH}));
    await prisma.characterTranslationJob.createMany({data,skipDuplicates:true});
    await prisma.characterTranslationJob.updateMany({where:{id:{in:data.map(job=>job.id)},state:{in:["complete","cancelled"]}},data:{state:"queued",attempts:0,nextAttemptAt:new Date()}});
  }
}

/** Keep explicit editor fields while the queue supplies the rest of a new English card. */
export async function saveManualEnglishTranslation(row:TranslationSource&{id:string},overrides:Record<string,unknown>) {
  const content=Object.fromEntries(CHARACTER_TRANSLATION_FIELDS.map(field=>[field,field==="publicMemory"?memoryToText(row.publicMemory_en)||null:typeof row[`${field}_en`]==="string"?row[`${field}_en`]:null]));
  const complete=!!content.name&&!CHARACTER_TRANSLATION_FIELDS.some(field=>row[field]&&!content[field]);
  const fields=complete?content:Object.fromEntries(CHARACTER_TRANSLATION_FIELDS.map(field=>[field,Object.hasOwn(overrides,field)?content[field]:null]));
  const data={...fields,sourceHash:characterTranslationHash(row),pipelineHash:complete?"manual":"manual-partial",qualityReviewedAt:complete?new Date():null};
  await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT "id" FROM "Character" WHERE "id"=${row.id} FOR UPDATE`;
    const current=await tx.character.findUnique({where:{id:row.id},select:characterTranslationSourceSelect});
    if(!current||characterTranslationHash(current)!==data.sourceHash)return;
    await tx.characterTranslation.upsert({where:{characterId_locale:{characterId:row.id,locale:"en"}},create:{characterId:row.id,locale:"en",...data},update:data});
  });
}
let reconcileAt=0;
async function reconcile() {
  if(Date.now()<reconcileAt)return;
  reconcileAt=Date.now()+60000;
  // Discovery also covers publication through admin tools. It never invokes a paid provider.
  const rows=await prisma.character.findMany({where:{isPublic:true},select:{id:true}});
  for(const row of rows)await enqueueCharacterTranslations(row.id);
}
async function reserveBudget(stage:TranslationStage,body:TranslationRequest) {
  const limit=Number(process.env.CHARACTER_TRANSLATION_DAILY_BUDGET_USD||"1");
  if(!Number.isFinite(limit)||limit<=0||limit>100)throw new CharacterTranslationError("translation_daily_budget");
  const rate=TRANSLATION_MODELS[stage],id=`translation:${new Date().toISOString().slice(0,10)}`;
  // UTF-8 bytes bound token counts conservatively; unknown/time-out usage retains its reservation.
  const inputUpper=Buffer.byteLength(JSON.stringify(body),"utf8")+1024;
  const amount=(inputUpper*rate.input+body.max_tokens*rate.output)/1e6;
  const reserved=await prisma.$transaction(async tx=>{
    await tx.characterTranslationBudget.upsert({where:{id},create:{id},update:{}});
    return tx.$executeRaw`UPDATE "CharacterTranslationBudget" SET "usedUsd"="usedUsd"+${amount} WHERE "id"=${id} AND "usedUsd"+${amount}<=${limit}`;
  });
  if(!reserved)throw new CharacterTranslationError("translation_daily_budget");
  return async(usage:{prompt_tokens:number;completion_tokens:number})=>{
    const actual=(usage.prompt_tokens*rate.input+usage.completion_tokens*rate.output)/1e6;
    await prisma.characterTranslationBudget.update({where:{id},data:{usedUsd:{increment:actual-amount}}});
  };
}
export async function characterTranslationStatus() {
  return {enabled:characterTranslationEnabled(),jobs:await prisma.characterTranslationJob.groupBy({by:["state"],_count:true})};
}
export async function processCharacterTranslationJob() {
  if(!characterTranslationEnabled())return {processed:0};
  await reconcile();
  await prisma.$executeRaw`UPDATE "CharacterTranslationJob" SET "state"='failed',"errorCode"='translation_lease_expired',"leaseToken"=NULL,"leaseUntil"=NULL WHERE "state"='processing' AND "leaseUntil"<CURRENT_TIMESTAMP AND "attempts">=3`;
  const token=randomUUID();
  const claimed=await prisma.$queryRaw<{id:string}[]>`UPDATE "CharacterTranslationJob" SET "state"='processing',"attempts"="attempts"+1,"leaseToken"=${token},"leaseUntil"=CURRENT_TIMESTAMP+INTERVAL '20 minutes',"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=(SELECT "id" FROM "CharacterTranslationJob" WHERE "attempts"<3 AND (("state" IN ('queued','retry') AND "nextAttemptAt"<=CURRENT_TIMESTAMP) OR ("state"='processing' AND "leaseUntil"<CURRENT_TIMESTAMP)) ORDER BY "nextAttemptAt","createdAt" FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING "id"`;
  if(!claimed[0])return {processed:0};
  const job=await prisma.characterTranslationJob.findUniqueOrThrow({where:{id:claimed[0].id}});
  const owned={id:job.id,leaseToken:token};
  const release=(data:Prisma.CharacterTranslationJobUpdateManyMutationInput)=>prisma.characterTranslationJob.updateMany({where:owned,data});
  try{
    const row=await prisma.character.findUnique({where:{id:job.characterId},select:characterTranslationSourceSelect});
    if(!row?.isPublic||characterTranslationHash(row)!==job.sourceHash||job.policyHash!==TRANSLATION_POLICY_HASH){await release({state:"cancelled",leaseToken:null,leaseUntil:null});return {processed:1,state:"cancelled"};}
    const existing=await prisma.characterTranslation.findUnique({where:{characterId_locale:{characterId:job.characterId,locale:job.locale}}});
    if(existing?.sourceHash===job.sourceHash&&[TRANSLATION_POLICY_HASH,"manual"].includes(existing.pipelineHash||"")){
      await release({state:"complete",checkpoint:{},leaseToken:null,leaseUntil:null});return {processed:1,state:"complete"};
    }
    const checkpoint={...(job.checkpoint as Record<string,unknown>)};
    const content=await translateCharacterContent(row,job.locale,{checkpoint:{load:async key=>checkpoint[key],save:async(key,value)=>{
      if(value===undefined)delete checkpoint[key];else checkpoint[key]=value;
      const changed=await release({checkpoint:checkpoint as Prisma.InputJsonObject});if(!changed.count)throw new CharacterTranslationError("translation_lease_lost");
    }},ask:async(stage,body)=>{
      if(!await prisma.characterTranslationJob.count({where:owned}))throw new CharacterTranslationError("translation_lease_lost");
      const settle=await reserveBudget(stage,body);return requestCharacterTranslation(body,settle);
    }});
    const state=await prisma.$transaction(async tx=>{
      const locked=await tx.$queryRaw<{id:string}[]>`SELECT "id" FROM "CharacterTranslationJob" WHERE "id"=${job.id} AND "leaseToken"=${token} FOR UPDATE`;
      if(!locked.length)throw new CharacterTranslationError("translation_lease_lost");
      await tx.$queryRaw`SELECT "id" FROM "Character" WHERE "id"=${job.characterId} FOR UPDATE`;
      const current=await tx.character.findUnique({where:{id:job.characterId},select:characterTranslationSourceSelect});
      const old=await tx.characterTranslation.findUnique({where:{characterId_locale:{characterId:job.characterId,locale:job.locale}}});
      const valid=current?.isPublic&&characterTranslationHash(current)===job.sourceHash;
      if(valid&&!(old?.pipelineHash==="manual"&&old.sourceHash===job.sourceHash)){
        const manual=old?.pipelineHash==="manual-partial"&&old.sourceHash===job.sourceHash?Object.fromEntries(CHARACTER_TRANSLATION_FIELDS.filter(field=>old[field]!==null).map(field=>[field,old[field]])):{};
        const data={...content,...manual,sourceHash:job.sourceHash,pipelineHash:Object.keys(manual).length?"manual":TRANSLATION_POLICY_HASH,qualityReviewedAt:new Date()};
        await tx.characterTranslation.upsert({where:{characterId_locale:{characterId:job.characterId,locale:job.locale}},create:{characterId:job.characterId,locale:job.locale,...data},update:data});
      }
      const state=valid?"complete":"cancelled";
      await tx.characterTranslationJob.update({where:{id:job.id},data:{state,checkpoint:{},leaseToken:null,leaseUntil:null,errorCode:null}});
      return state;
    });
    return {processed:1,state};
  }catch(error){
    const code=error instanceof CharacterTranslationError?error.code:"translation_provider_failed";
    const budget=code==="translation_daily_budget";
    const next=budget?new Date(Date.parse(new Date().toISOString().slice(0,10))+86400000):new Date(Date.now()+job.attempts*60000);
    const state=budget||job.attempts<3?"retry":"failed";
    await release({state,nextAttemptAt:next,errorCode:code,leaseToken:null,leaseUntil:null,...(budget?{attempts:{decrement:1}}:{})});
    return {processed:1,state,code};
  }
}
