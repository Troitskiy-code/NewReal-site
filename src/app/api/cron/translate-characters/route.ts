import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getCronProvidedSecret } from "@/lib/cronAuth";
import { characterTranslationStatus, processCharacterTranslationJob } from "@/lib/characterTranslationQueue";
import { withAiCostContext } from "@/lib/aiCostTelemetry";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";

export const runtime="nodejs";
export const maxDuration=1200;
async function handle(req:NextRequest,apply:boolean) {
  const secret=process.env.CRON_SECRET,provided=getCronProvidedSecret(req);
  if(!secret||!provided||Buffer.byteLength(secret)!==Buffer.byteLength(provided)||!timingSafeEqual(Buffer.from(secret),Buffer.from(provided)))return NextResponse.json({error:"Недостаточно прав"},{status:401});
  try{return NextResponse.json(apply?await withAiCostContext(()=>processCharacterTranslationJob()):await characterTranslationStatus());}
  catch(error){errorLog("Translation","Worker unavailable",toSafeDiagnostic(error));return NextResponse.json({error:"Не удалось обработать перевод"},{status:503});}
}
export const GET=(req:NextRequest)=>handle(req,false);
export const POST=(req:NextRequest)=>handle(req,true);
