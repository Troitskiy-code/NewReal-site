/** Offline validation/export only. Production writes are separately reviewed in Adminer. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {TRANSLATION_LOCALES,TRANSLATION_POLICY_HASH,validateCharacterTranslation} from '../src/lib/characterTranslationPipeline.ts';
import {characterTranslationSource,characterTranslationHash} from '../src/lib/characterTranslationData.ts';
import {translationImportSql} from './lib/localization-pack.mjs';
const directory=path.resolve('.runtime/localization-v2');
if(fs.existsSync(path.join(directory,'writer.lock')))throw new Error('Wait until the paid catalog runner drains');
const catalog=JSON.parse(fs.readFileSync(path.join(directory,'catalog-public-2026-10-29.json'),'utf8'));
const fields=['name','description','descriptionCard','appearance','greeting','scenario','exampleDialogs','avatarPrompt','publicMemory'];
const allowed=new Set(['id','isPublic',...fields]);
if(catalog.some(row=>row.isPublic!==true||Object.keys(row).some(key=>!allowed.has(key)))||new Set(catalog.map(row=>row.id)).size!==catalog.length)throw new Error('Only unique public source records are allowed');
const output=path.join(directory,'production-import');fs.mkdirSync(output,{recursive:true});
const batches=path.join(output,'batches');fs.mkdirSync(batches,{recursive:true});const batchPlan=[];
const files=fs.readdirSync(directory),outcomes=new Map(JSON.parse(fs.readFileSync(path.join(directory,'outcomes.json'),'utf8')).map(row=>[row.id,row]));
const missing=[],invalid=[],coverage={},recovered=[];
function validated(file,row,locale){
  const record=JSON.parse(fs.readFileSync(file,'utf8'));
  if(record.characterId!==row.id||record.locale!==locale||record.sourceHash!==characterTranslationHash(row)||record.policyHash!==TRANSLATION_POLICY_HASH)throw new Error('translation_stale_metadata');
  validateCharacterTranslation(Object.fromEntries(fields.map(field=>[field,record[field]])),characterTranslationSource(row),locale);
  return record;
}
for(const locale of TRANSLATION_LOCALES){
  const records=[];
  for(const row of catalog){
    const id=`${row.id}-${locale}`,name=`${id}-result.json`,file=path.join(directory,name);
    let record;
    if(fs.existsSync(file)){try{record=validated(file,row,locale);}catch(error){invalid.push({id,code:error.message});}}
    if(!record&&process.argv.includes('--recover-rejected'))for(const candidate of files.filter(f=>f.startsWith(name+'.rejected-')).sort().reverse()){
      try{record=validated(path.join(directory,candidate),row,locale);fs.writeFileSync(file,JSON.stringify(record));recovered.push(id);break;}catch{}
    }
    if(record)records.push(record);
    else{
      const sourceHash=characterTranslationHash(row),jobId=createHash('sha256').update(JSON.stringify([row.id,locale,sourceHash,TRANSLATION_POLICY_HASH])).digest('hex');
      missing.push({id:jobId,characterId:row.id,name:row.name,locale,sourceHash,policyHash:TRANSLATION_POLICY_HASH,errorCode:outcomes.get(id)?.code||'translation_not_completed',source:Object.fromEntries(fields.map(field=>[field,row[field]??null]))});
    }
  }
  coverage[locale]={prepared:records.length,remaining:catalog.length-records.length};
  if(records.length)fs.writeFileSync(path.join(output,locale+'.sql'),translationImportSql(records,fields,{pipelineHash:TRANSLATION_POLICY_HASH}));
  for(let i=0;i<records.length;i+=50){const file=`${locale}-${String(i/50+1).padStart(2,'0')}.sql`,part=records.slice(i,i+50);fs.writeFileSync(path.join(batches,file),translationImportSql(part,fields,{pipelineHash:TRANSLATION_POLICY_HASH}));batchPlan.push({locale,file,prepared:part.length});}
}
fs.writeFileSync(path.join(batches,'plan.json'),JSON.stringify(batchPlan));
if(missing.length){
  const payload=Buffer.from(JSON.stringify(missing)).toString('base64'),original=fields.map(field=>`'${field}',c."${field}"`).join(',');
  // Keep failed bulk work out of automatic paid retries. A source edit gets a new
  // identity; an operator can deliberately retry this exact revision after review.
  fs.writeFileSync(path.join(output,'hold-unreviewed.sql'),`WITH input AS (
 SELECT * FROM jsonb_to_recordset(convert_from(decode('${payload}','base64'),'UTF8')::jsonb)
 AS r(id text,"characterId" text,locale text,"sourceHash" text,"policyHash" text,source jsonb)
), held AS (
 INSERT INTO public."CharacterTranslationJob"(id,"characterId",locale,"sourceHash","policyHash",state,attempts,"errorCode")
 SELECT r.id,r."characterId",r.locale,r."sourceHash",r."policyHash",'failed',3,'bulk_manual_review_required'
 FROM input r JOIN public."Character" c ON c.id=r."characterId"
 WHERE c."isPublic"=true AND jsonb_build_object(${original})=r.source
 AND NOT EXISTS(SELECT 1 FROM public."CharacterTranslation" t WHERE t."characterId"=r."characterId" AND t.locale=r.locale AND t."sourceHash"=r."sourceHash" AND t."pipelineHash"=r."policyHash")
 ON CONFLICT(id) DO NOTHING RETURNING id
) SELECT COUNT(*) AS manual_review_jobs FROM held;`);
}
function costs(folder){
  const events=new Map();for(const line of fs.readFileSync(path.join(folder,'usage.ndjson'),'utf8').trim().split('\n')){const row=JSON.parse(line);events.set(row.id,row);}
  const list=[...events.values()];return {requests:list.length,usageEstimateUsd:list.filter(row=>row.usageConfirmed).reduce((s,row)=>s+row.accountedUsd,0),upperWithUnconfirmedUsd:list.reduce((s,row)=>s+row.accountedUsd,0)};
}
const cost={cards:costs(directory),interface:costs(path.resolve('.runtime/localization-v2-ui')),accountingUsdRub:108.192};
const report={generatedAt:new Date().toISOString(),policyHash:TRANSLATION_POLICY_HASH,publicCharacters:catalog.length,plannedVariants:catalog.length*TRANSLATION_LOCALES.length,validatedVariants:Object.values(coverage).reduce((s,row)=>s+row.prepared,0),coverage,recovered,invalid,missing:missing.map(({source,...row})=>row),cost};
fs.writeFileSync(path.join(directory,'rollout-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({validatedVariants:report.validatedVariants,missing:missing.length,coverage,recovered:recovered.length,upperWithUnconfirmedRub:(cost.cards.upperWithUnconfirmedUsd+cost.interface.upperWithUnconfirmedUsd)*cost.accountingUsdRub}));
