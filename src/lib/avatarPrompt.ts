const SENSITIVE_CLIENT_MESSAGE =
  "Ваш запрос был отклонён из-за политики безопасности. Попробуйте изменить описание персонажа или использовать более нейтральные формулировки.";

const WORD_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bbeautiful\b/gi, "distinctive"],
  [/\bhandsome\b/gi, "fine-featured"],
  [/\bseductive\b/gi, "graceful"],
  [/\brevealing\b/gi, "modest"],
  [/\baggressive\b/gi, "determined"],
  [/\bsexy\b/gi, "stylish"],
  [/\bsensual\b/gi, "calm"],
  [/\berotic\b/gi, "artistic"],
  [/\bprovocative\b/gi, "expressive"],
  [/\bnude\b/gi, "clothed"],
  [/\bnaked\b/gi, "clothed"],
];

const REMOVED_WORDS = /\b(nsfw|explicit|porn|xxx)\b/gi;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizePromptText(value: string): string {
  let text = value.replace(REMOVED_WORDS, " ").replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of WORD_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text.slice(0, 280);
}

export function buildAvatarPrompt(body: {
  name?: unknown;
  appearance?: unknown;
  description?: unknown;
}): string {
  const name = sanitizePromptText(asText(body.name)) || "unnamed character";
  const appearance = sanitizePromptText(asText(body.appearance));
  const description = sanitizePromptText(asText(body.description));

  return [
    "safe, appropriate, family friendly fantasy character portrait",
    `of ${name}`,
    appearance,
    description,
    "fantasy character portrait, detailed, high quality, character art",
  ]
    .filter(Boolean)
    .join(", ");
}

export function isSensitiveGenerationError(error: unknown, extraText = ""): boolean {
  const parts = [extraText, String(error)];
  if (error instanceof Error) {
    parts.push(error.message, error.name);
  }
  const text = parts.join(" ").toLowerCase();
  return (
    text.includes("flagged as sensitive") ||
    text.includes("sensitive content") ||
    text.includes("sensitive") ||
    text.includes("nsfw")
  );
}

export { SENSITIVE_CLIENT_MESSAGE };
