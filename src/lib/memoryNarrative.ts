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
  ["done", /наш[её]л|нашли|потерял|потеряли|закопал|спрятал|отдал|передал|выполн|создал|поднял|повысил|объявил|заверш|found|lost|completed|announced/iu],
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
  return new Set((text.match(/\p{Lu}[\p{L}'-]+/gu) ?? []).map((word) => word.toLowerCase().replace(/ё/g, "е")
    .replace(/^(.{5,})[ауюы]$/u, "$1")).filter((word) => !DISCOURSE.has(word)));
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

export function safeMemoryParaphrase(text: string, evidence: string): string {
  return isSupportedMemoryText(text, evidence) ? text.replace(/\s+/g, " ").trim()
    : stripMemoryControlInstructions(evidence).replace(/\s+/g, " ").trim();
}
