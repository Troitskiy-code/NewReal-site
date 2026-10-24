import { stripMemoryControlInstructions } from "./memorySafety";

export const MEMORY_STATUSES = ["reported", "proposed", "decided", "promised", "done", "cancelled", "uncertain"] as const;
export type MemoryStatus = typeof MEMORY_STATUSES[number];
export const STATUS_LABELS: Record<MemoryStatus, string> = {
  reported: "Сообщено", proposed: "Предложено", decided: "Решено", promised: "Обещано",
  done: "Выполнено", cancelled: "Отменено", uncertain: "Неясно",
};

const STATUS_PATTERNS: Array<[MemoryStatus, RegExp]> = [
  ["cancelled", /отмен|отлож|передум|больше не|не будем|cancel|postpon/iu],
  ["proposed", /предлаг|предлож|(?:^|[^\p{L}])(?:можно|следует|нужно|должен|должны|стоит)(?=$|[^\p{L}])|suggest|propos|should/iu],
  ["promised", /обещ|гарантир|promise|guarantee/iu],
  ["decided", /решил|решено|решили|принят|соглас|утверд|будет|состоится|планиру|завтра|послезавтра|decid|agreed|will/iu],
  ["done", /наш[её]л|нашли|потерял|потеряли|закопал|спрятал|отдал|передал|выполн|создал|поднял|повысил|объявил|заверш|отправил(?:ся|ась|ись)|приш[её]л|пришли|found|lost|completed|announced/iu],
];
export function inferMemoryStatus(text: string): MemoryStatus {
  const labelled = /^(?:По словам персонажа:\s*|Персонаж\s*)?\[(Сообщено|Предложено|Решено|Обещано|Выполнено|Отменено|Неясно)(?:;[^\]]*)?\]/iu.exec(text.trim());
  if (labelled) return MEMORY_STATUSES.find((key) => STATUS_LABELS[key].toLowerCase() === labelled[1].toLowerCase())!;
  if (text.trim().endsWith("?")) return "reported";
  if (/(?:^|[^\p{L}])не\s+(?:отмен[яи]|обеща|реши|утверди|выполни|наш[её]л|повыси)/iu.test(text)) return "reported";
  // A proposal to cancel/complete something is still a proposal.
  if (/предлага|предложи[лт]|предложить|suggest|propose/iu.test(text)) return "proposed";
  const status = STATUS_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "reported";
  return status === "done" && NEGATION.test(text) ? "reported" : status;
}

const NEGATION = /(?:^|[^\p{L}])(?:не|нет|без|никогда|not|no|never|without)(?=$|[^\p{L}])/iu;
export function memoryNumbers(text: string): string[] {
  return [...new Set((text.match(/\d+(?:[.,]\d+)?(?:\s*%|\s*₽)?/gu) ?? [])
    .map((value) => value.replace(/\s/g, "").replace(",", ".")))].sort();
}
const DISCOURSE = new Set(["персонаж", "пользователь", "по", "я", "мы", "он", "она", "они", "это", "если", "при", "для", "план", "решение", "повышение", "учётная", "учетная", "официальное", "ставка", "ключ", "утром", "вечером", "сообщено", "предложено", "решено", "обещано", "выполнено", "отменено", "неясно", "из", "the", "i"]);
function names(text: string): Set<string> {
  const transitions = new Set(["сначала", "затем", "позже", "теперь", "однако", "поэтому", "после"]);
  return new Set((text.match(/\p{Lu}[\p{L}'-]+/gu) ?? []).map((word) => word.toLowerCase().replace(/ё/g, "е"))
    .filter(word => !transitions.has(word)).map(word => word.replace(/^(.{5,})[ауюы]$/u, "$1"))
    .filter((word) => !DISCOURSE.has(word)));
}
const STOP = new Set(["персонаж", "пользователь", "словам", "сообщил", "сообщено", "рассказал", "предложено", "решено", "обещано", "выполнено", "отменено", "неясно", "будет", "будут", "этого", "чтобы", "нашему", "нашего"]);
export function memoryTerms(text: string): Set<string> {
  return new Set((text.toLowerCase().replace(/ё/g, "е").match(/[\p{L}]{4,}/gu) ?? [])
    .filter((word) => !STOP.has(word)).map((word) => word.length > 5 ? word.slice(0, 5) : word));
}
export function memoryOverlap(left: string, right: string): number {
  const a = memoryTerms(left), b = memoryTerms(right);
  if (!a.size || !b.size) return 0;
  return [...a].filter((term) => b.has(term)).length / Math.min(a.size, b.size);
}

/** Conservative checks, not a semantic entailment proof. Failed paraphrases use source text. */
export function isSupportedMemoryText(text: string, evidence: string): boolean {
  if (!text.trim() || text.length > 1200 || stripMemoryControlInstructions(text) !== text) return false;
  if (NEGATION.test(text) !== NEGATION.test(evidence)) return false;
  const candidateStatus = inferMemoryStatus(text), sourceStatus = inferMemoryStatus(evidence);
  if (candidateStatus !== "reported" && candidateStatus !== sourceStatus) return false;
  const actualNumbers = memoryNumbers(text), sourceNumbers = memoryNumbers(evidence);
  if (actualNumbers.join("|") !== sourceNumbers.join("|")) return false;
  const supportedNames = names(evidence);
  if ([...names(text)].some((name) => !supportedNames.has(name))) return false;
  const terms = memoryTerms(text), sourceTerms = memoryTerms(evidence);
  return terms.size > 0 && [...terms].filter((term) => sourceTerms.has(term)).length / terms.size >= 0.5;
}

export function sameMemoryMeaning(left: string, right: string): boolean {
  if (inferMemoryStatus(left) !== inferMemoryStatus(right) || NEGATION.test(left) !== NEGATION.test(right)) return false;
  if (memoryNumbers(left).join("|") !== memoryNumbers(right).join("|")) return false;
  const a = names(left), b = names(right);
  if (a.size !== b.size || [...a].some((name) => !b.has(name))) return false;
  const leftTerms = memoryTerms(left), rightTerms = memoryTerms(right);
  const common = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  return common / Math.max(leftTerms.size, rightTerms.size, 1) >= 0.8;
}

const nameKey = (word: string) => word.toLowerCase().replace(/ё/g, "е").replace(/^(.{5,})[ауюы]$/u, "$1");
/** Case forms of one name share a stem: «Вика/Вику», «Артём/Артёма». */
function sameName(left: string, right: string): boolean {
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return long.startsWith(short.length > 3 ? short.slice(0, -1) : short);
}
/** «Артёма» and «Артём» are one participant. */
export function isSameMemoryName(left: string, right: string): boolean {
  return sameName(nameKey(left), nameKey(right));
}
export function knownMemoryNames(text: string): string[] {
  return [...names(text)];
}

/**
 * One sentence of a retelling. Roleplay evidence is first person and rarely names anyone,
 * so a retelling is checked against all cited quotes together, and names may come from the
 * whole request. The first word is capitalised by grammar: it is a name only when it is not
 * an ordinary word of the evidence. Completion, cancellation and promises still need a source
 * with that status, and a cited denial blocks the positive claim.
 */
export const RETELLING_REJECTIONS = ["control", "person", "copy", "fragment", "speaker", "status", "number", "negation", "contradiction", "name", "terms"] as const;
/** A retelling is third person. «я/ты/мы» or a *stage direction* is a pasted roleplay reply,
 * which passes every overlap check by being a copy (prod rebuild 2026-10-24). */
const ROLEPLAY_VOICE = /\*|(?:^|[^\p{L}])(?:я|меня|мне|мной|мой|моя|моё|мое|мои|моего|моей|моих|мы|нас|нам|нами|наш|наша|наше|наши|ты|тебя|тебе|тобой|твой|твоя|твоё|твое|твои|твоего|твоей)(?=$|[^\p{L}])/iu;
export const hasRoleplayVoice = (text: string) => ROLEPLAY_VOICE.test(text);
export type RetellingRejection = typeof RETELLING_REJECTIONS[number];
export function isSupportedRetelling(sentence: string, evidence: Array<{ text: string; status?: MemoryStatus }>,
  knownNames: string[]): boolean {
  return retellingRejection(sentence, evidence, knownNames) === null;
}
/** Share of a narrative sentence's terms that must occur in its evidence. A retelling in its own
 * words matched 38–56% of the source terms and lost whole items at 1/2 (Gemma 16 items per
 * rebuild, eval 2026-10-24); invented sentences stayed at 0–25%. */
export const RETELLING_TERM_SHARE = 1 / 3;
/** The first rule a retelling sentence breaks, or null. Only enums leave this function. */
export function retellingRejection(sentence: string, evidence: Array<{ text: string; status?: MemoryStatus }>,
  knownNames: string[], denials: Array<{ text: string }> = evidence, termShare = 0.5): RetellingRejection | null {
  if (!sentence.trim() || stripMemoryControlInstructions(sentence) !== sentence) return "control";
  if (ROLEPLAY_VOICE.test(sentence)) return "person";
  if (!evidence.length) return "speaker";
  const joined = evidence.map(row => row.text).join(" ");
  const status = inferMemoryStatus(sentence);
  if ((status === "done" || status === "cancelled" || status === "promised")
    && !evidence.some(row => (row.status ?? inferMemoryStatus(row.text)) === status)) return "status";
  const available = new Set(memoryNumbers(joined));
  if (memoryNumbers(sentence).some(value => !available.has(value))) return "number";
  const terms = memoryTerms(sentence), sourceTerms = memoryTerms(joined);
  if (NEGATION.test(sentence)) {
    if (!evidence.some(row => NEGATION.test(row.text))) return "negation";
  } else if (denials.some(row => {
    if (!NEGATION.test(row.text)) return false;
    const denied = memoryTerms(row.text);
    return [...terms].filter(term => denied.has(term)).length / Math.max(terms.size, denied.size, 1) >= 0.5;
  })) return "contradiction";
  const known = [...names(joined), ...knownNames.map(nameKey)];
  const nameTerms = new Set<string>();
  for (const match of sentence.matchAll(/\p{Lu}[\p{L}'-]+/gu)) {
    const word = nameKey(match[0]);
    if (names(match[0]).size === 0) continue;
    if (known.some(name => sameName(name, word))) {
      for (const term of memoryTerms(match[0])) nameTerms.add(term);
      continue;
    }
    const initial = /^[\s"«(*—–-]*$/u.test(sentence.slice(0, match.index));
    const term = memoryTerms(match[0]);
    // «Три», «Но», «Их»: a short opening word is a function word, not an unknown name.
    if (initial && (!term.size || [...term].every(value => sourceTerms.has(value)))) continue;
    return "name";
  }
  // Names are verified above and do not count as support, unless they are all the sentence has.
  const withoutNames = [...terms].filter(term => !nameTerms.has(term));
  const content = withoutNames.length ? withoutNames : [...terms];
  return content.length > 0 && content.filter(term => sourceTerms.has(term)).length / content.length >= termShare ? null : "terms";
}

/** A quoted gesture or two-word reply («Можешь.», «За спину.») is not an event worth a prompt
 * line. The stored «По словам персонажа: [Сообщено]» prefix does not count. */
export function isTrivialEvent(event: string): boolean {
  const body = event.replace(/^(?:По словам персонажа:\s*)?\[[^\]]+\]\s*/u, "").replace(/\*/g, " ");
  return (body.match(/[\p{L}\p{N}]+/gu) ?? []).length < 3;
}

export function safeMemoryParaphrase(text: string, evidence: string): string {
  return isSupportedMemoryText(text, evidence) ? text.replace(/\s+/g, " ").trim()
    : stripMemoryControlInstructions(evidence).replace(/\s+/g, " ").trim();
}
