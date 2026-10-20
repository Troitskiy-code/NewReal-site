import { prisma } from "@/lib/prisma";
import { characterGender } from "./characterGenerationChecks";
import { threadPromptScopeKey } from "./chatThreads";
import { DEFAULT_SPEECH_VOICE, FEMALE_SPEECH_VOICE, NARRATOR_SPEECH_VOICE, type SpeechVoiceDefault } from "./speech";

type VoiceCard = { roleplayMode: string; tags: string | null; appearance: string | null; appearance_en: string | null;
  description: string | null; description_en: string | null };

/** Read the fictional speaker's profile, never the player's persona or the dialogue's other characters. */
export function automaticSpeechVoice(card: VoiceCard, storyMode?: string | null): SpeechVoiceDefault {
  if ((storyMode ?? card.roleplayMode) === "world" || (storyMode ?? card.roleplayMode) === "group")
    return { voice: NARRATOR_SPEECH_VOICE, role: "narrator" };
  const explicitTags = card.tags ?? "";
  // Conflicting tags cannot establish the main speaker's gender.
  const maleTag = /Мужской персонаж|\bmale(?: character)?\b/i.test(explicitTags);
  const femaleTag = /Женский персонаж|\bfemale(?: character)?\b/i.test(explicitTags);
  let gender = maleTag !== femaleTag ? maleTag ? "male" : "female" : null;
  if (!maleTag && !femaleTag) gender = characterGender({ tags: "", appearance: card.appearance ?? "" });
  if (!gender && !maleTag && !femaleTag) {
    // An explicit subject in the appearance is stronger evidence than incidental people in a backstory.
    const appearance = card.appearance_en?.slice(0, 120) ?? "";
    const male = /\b(?:he|his|him|man|male|boy)\b/i.test(appearance);
    const female = /\b(?:she|her|woman|female|girl)\b/i.test(appearance);
    if (male !== female) gender = male ? "male" : "female";
  }
  if (!gender && !maleTag && !femaleTag) {
    // Only unambiguous first-person/profile openings; do not count the user's gender or names.
    const intro = `${card.description ?? ""}\n${card.description_en ?? ""}`.slice(0, 320)
      .split(/(?<=[.!?])\s+|\n/u)
      .filter(sentence => !/(?<!\p{L})(?:ты|тебя|твой|вы|ваш|you|your)(?!\p{L})|\{\{user\}\}/iu.test(sentence)).join("\n");
    const male = /(?:^|[.!?\n])\s*(?:он\s|he\s)|(?:^|[—–,:])\s*(?:мужчина|парень|юноша|старик|a man|a boy)(?!\p{L})/iu.test(intro);
    const female = /(?:^|[.!?\n])\s*(?:она\s|she\s)|(?:^|[—–,:])\s*(?:женщина|девушка|старушка|a woman|a girl)(?!\p{L})/iu.test(intro);
    if (male !== female) gender = male ? "male" : "female";
  }
  return gender === "female" ? { voice: FEMALE_SPEECH_VOICE, role: "female" }
    : { voice: DEFAULT_SPEECH_VOICE, role: gender === "male" ? "male" : "unknown" };
}

/** Caller must have authorized this exact character and story first. No new prompt state or AI call. */
export async function getAutomaticSpeechVoice(characterId: string, threadId: string | null): Promise<SpeechVoiceDefault> {
  const [card, state] = await Promise.all([
    prisma.character.findUnique({ where: { id: characterId }, select: {
      roleplayMode: true, tags: true, appearance: true, appearance_en: true, description: true, description_en: true,
    } }),
    threadId ? prisma.chatPromptState.findUnique({
      where: { scopeKey_characterId: { scopeKey: threadPromptScopeKey(threadId), characterId } }, select: { mode: true },
    }) : null,
  ]);
  return card ? automaticSpeechVoice(card, state?.mode) : { voice: DEFAULT_SPEECH_VOICE, role: "unknown" };
}
