import { meteredPost } from "./aiCostTelemetry";
import { type TranslationSource } from "./characterTranslationData";
import { CharacterTranslationError, translateCharacterTwoStage, type TranslationAsk, type TranslationCheckpoint, type TranslationRequest } from "./characterTranslationPipeline";
export { characterTranslationSource, characterTranslationHash, type TranslationSource } from "./characterTranslationData";

export async function requestCharacterTranslation(body:TranslationRequest,onUsage?:(usage:{prompt_tokens:number;completion_tokens:number})=>Promise<void>) {
  if(!process.env.DEEPINFRA_API_KEY)throw new CharacterTranslationError("translation_disabled");
  const response=await meteredPost("translation","https://api.deepinfra.com/v1/openai/chat/completions",body,{
    headers:{Authorization:`Bearer ${process.env.DEEPINFRA_API_KEY}`},timeout:240000,
  });
  const data=response.data;
  if(Number.isSafeInteger(data?.usage?.prompt_tokens)&&data.usage.prompt_tokens>=0&&Number.isSafeInteger(data?.usage?.completion_tokens)&&data.usage.completion_tokens>=0)await onUsage?.(data.usage);
  if(data?.choices?.[0]?.finish_reason!=="stop"||typeof data.choices[0].message?.content!=="string")throw new CharacterTranslationError("translation_incomplete");
  return JSON.parse(data.choices[0].message.content);
}
/** Whole-card translation and evidence-based editorial patches. No private fields or provider fallback. */
export async function translateCharacterContent(source:TranslationSource,locale:string,options:{ask?:TranslationAsk;checkpoint?:TranslationCheckpoint}={}) {
  return translateCharacterTwoStage(source,locale,options.ask||((_stage,body)=>requestCharacterTranslation(body)),options.checkpoint);
}
