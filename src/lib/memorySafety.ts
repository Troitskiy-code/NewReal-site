// A conservative guard for known control instructions, not a general proof of model safety.
const CONTROL_INSTRUCTION_PATTERNS = [
  /(?:игнорир\p{L}*|забудь|отмени|отключи|не\s+(?:следуй|соблюдай|выполняй)).{0,90}(?:правил|инструкц|промпт|системн|предыдущ|выше)/iu,
  /(?:ignore|disregard|forget|override|bypass|disable).{0,90}(?:instructions?|rules?|system|prompt|previous|above|safety)/iu,
  /(?:отвечай|ответь|пиши|выводи|выдай|скажи).{0,60}(?:только|лишь|строго|всегда)/iu,
  /(?:respond|reply|answer|output|print|say).{0,60}(?:only|exactly|always)/iu,
  /(?:ты\s+теперь|твоя\s+новая\s+роль|you\s+are\s+now|your\s+new\s+role)/iu,
  /(?:^|\s)(?:system|developer|assistant)\s*[:：]|<\/?(?:system|developer|assistant)>|\[\/?INST\]|<<\/?SYS>>/iu,
];

export function hasMemoryControlInstruction(text: string): boolean {
  const comparable = text.normalize("NFKC").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "");
  return CONTROL_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(comparable));
}

/** Preserve ordinary facts; omit control-bearing sentences before they reach any memory model. */
export function stripMemoryControlInstructions(text: string): string {
  return text.split(/\r?\n/).map((line) => line
    .split(/(?<=[.!?;])\s+/u)
    .filter((sentence) => !hasMemoryControlInstruction(sentence))
    .join(" "))
    .filter((line) => line.trim())
    .join("\n");
}
