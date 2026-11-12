import { meteredChatFetch } from "./aiCostTelemetry";
import { ChatCompletionStreamParser, extractChatStreamDelta } from "./chatCompletionStream";
import { type TranslationSource } from "./characterTranslationData";
import { CharacterTranslationError, translateCharacterTwoStage, type TranslationAsk, type TranslationCheckpoint, type TranslationRequest } from "./characterTranslationPipeline";
export { characterTranslationSource, characterTranslationHash, type TranslationSource } from "./characterTranslationData";

const DEEPINFRA_CHAT_URL="https://api.deepinfra.com/v1/openai/chat/completions";
type StreamLimits={firstByteMs:number;idleMs:number;totalMs:number};
type Usage={prompt_tokens:number;completion_tokens:number};
/**
 * A whole-card draft can take longer than 4 minutes to generate (prod 06–09.11: 31 drafts cut at
 * exactly 240 s by the old non-streaming total timeout). Streaming keeps the request alive while
 * tokens arrive; a stalled provider still fails on the idle limit. The total limit stays below the
 * 20-minute job lease, which the queue renews before each paid call.
 */
export const TRANSLATION_STREAM_LIMITS:StreamLimits={firstByteMs:120_000,idleMs:90_000,totalMs:900_000};
const tokens=(value:unknown)=>Number.isSafeInteger(value)&&(value as number)>=0;

export async function requestCharacterTranslation(body:TranslationRequest,onUsage?:(usage:Usage)=>Promise<void>,limits:StreamLimits=TRANSLATION_STREAM_LIMITS) {
  if(!process.env.DEEPINFRA_API_KEY)throw new CharacterTranslationError("translation_disabled");
  const controller=new AbortController();
  const unref=(timer:ReturnType<typeof setTimeout>)=>{timer.unref?.();return timer;};
  const abortWith=(stage:"first_byte"|"idle"|"total")=>controller.abort(new CharacterTranslationError(`translation_timeout:${stage}`));
  const firstByte=unref(setTimeout(()=>abortWith("first_byte"),limits.firstByteMs));
  const total=unref(setTimeout(()=>abortWith("total"),limits.totalMs));
  let idle:ReturnType<typeof setTimeout>|undefined;
  const armIdle=()=>{clearTimeout(idle);idle=unref(setTimeout(()=>abortWith("idle"),limits.idleMs));};
  const stopTimers=()=>{clearTimeout(firstByte);clearTimeout(total);clearTimeout(idle);};
  // An abort surfaces as the signal's reason; report it as the timeout it was.
  const reason=(error:unknown)=>controller.signal.aborted&&controller.signal.reason instanceof CharacterTranslationError?controller.signal.reason:error;
  let response:Response;
  try{
    response=await meteredChatFetch(DEEPINFRA_CHAT_URL,{
      method:"POST",
      headers:{Authorization:`Bearer ${process.env.DEEPINFRA_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({...body,stream:true,stream_options:{include_usage:true}}),
      signal:controller.signal,
    },body.model,Math.ceil(body.messages.reduce((sum,message)=>sum+message.content.length,0)/4),stopTimers,armIdle,limits,"translation");
  }catch(error){stopTimers();throw reason(error);}
  clearTimeout(firstByte);armIdle();
  if(!response.ok||!response.body){
    stopTimers();await response.body?.cancel().catch(()=>{});
    throw new CharacterTranslationError("translation_provider_failed",{status:response.status});
  }
  let content="",usage:Usage|null=null;
  const parser=new ChatCompletionStreamParser((chunk,emitText)=>{
    const reported=chunk.usage as Partial<Usage>|undefined;
    if(reported&&tokens(reported.prompt_tokens)&&tokens(reported.completion_tokens))usage={prompt_tokens:reported.prompt_tokens!,completion_tokens:reported.completion_tokens!};
    if(emitText)content+=extractChatStreamDelta(chunk);
  });
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let failure:unknown;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;parser.push(decoder.decode(value,{stream:true}));}
    parser.push(decoder.decode());
  }catch(error){failure=reason(error);}
  finally{stopTimers();}
  const outcome=parser.end();
  // Usage arrives in the last frame; without it the budget keeps its upper-bound reservation.
  if(usage)await onUsage?.(usage);
  if(failure!==undefined)throw failure;
  if(outcome!=="completed"||parser.finishReason!=="stop")throw new CharacterTranslationError("translation_incomplete");
  try{return JSON.parse(content);}catch{throw new CharacterTranslationError("translation_invalid_json");}
}
/** Whole-card translation and evidence-based editorial patches. No private fields or provider fallback. */
export async function translateCharacterContent(source:TranslationSource,locale:string,options:{ask?:TranslationAsk;checkpoint?:TranslationCheckpoint}={}) {
  return translateCharacterTwoStage(source,locale,options.ask||((_stage,body)=>requestCharacterTranslation(body)),options.checkpoint);
}
