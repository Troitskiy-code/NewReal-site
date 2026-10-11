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

function sanitizePromptText(value: string, maxLength = 280): string {
  let text = value.replace(REMOVED_WORDS, " ").replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of WORD_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  if (text.length <= maxLength) return text;
  // Cut at a word boundary so the model never sees a half word.
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/** Ends a fragment with exactly one period, so user text and the template read as separate sentences. */
function sentence(text: string): string {
  const trimmed = text.replace(/[\s.,;:!?…]+$/u, "");
  return trimmed ? `${trimmed}.` : "";
}

export type AvatarStyle = "anime" | "realistic";

// Natural-language style lines: Seedream 5 and Nano Banana follow descriptions better than SD-era tag lists.
const STYLE_PROMPT: Record<AvatarStyle, string> = {
  anime: "Anime illustration with clean line art, cel shading and vibrant colors.",
  realistic: "Photorealistic portrait photography with natural skin texture and soft cinematic lighting.",
};

const COVER_STYLE_PROMPT: Record<AvatarStyle, string> = {
  anime: "Anime-style illustration with clean line art, rich colors and atmospheric lighting.",
  realistic: "Photorealistic cinematic illustration with natural light and atmospheric depth.",
};

// Cards crop the 3:4 image to 2:3 and the character page to a wide frame anchored near the top,
// so the face has to sit in the upper third with some headroom.
const PORTRAIT_FRAMING =
  "a waist-up character portrait, centered, with the face in the upper third of the frame and some space above the head, looking at the viewer";
const PORTRAIT_BACKGROUND = "Background: a simple atmospheric setting that fits the character, softly out of focus.";
const COVER_FRAMING =
  "Vertical cover art composition with a clear focal point in the upper half of the frame and atmospheric depth.";

// Names stay out of the prompt: both models render text well and would print them,
// and a famous name can pull in a real person's face.
const PORTRAIT_CONSTRAINTS =
  "Tasteful and non-explicit, fully clothed. Exactly one character. No text, letters, captions, logos, watermarks or frames.";
const COVER_CONSTRAINTS = "Tasteful and non-explicit. No text, letters, titles, captions, logos, watermarks or frames.";

// Without this, the editing model tends to retouch the uploaded photo instead of drawing the character.
const PORTRAIT_REFERENCE =
  "Use the person in the reference image as the character's likeness: keep the face, facial proportions, hairstyle and distinctive features recognizable. Create a new portrait rather than editing the photo, and do not copy its background, framing, pose or lighting.";
const COVER_REFERENCE =
  "Use the reference image for the look of the main subject, but create a new illustration rather than editing the photo.";

export function resolveAvatarStyle(value: unknown): AvatarStyle {
  return value === "anime" ? "anime" : "realistic";
}

export function buildAvatarPrompt(body: {
  name?: unknown;
  appearance?: unknown;
  description?: unknown;
  style?: unknown;
  avatarPrompt?: unknown;
  customPrompt?: unknown;
  roleplayMode?: unknown;
  referenceImage?: unknown;
}): string {
  const style = resolveAvatarStyle(body.style);
  const withReference = Boolean(asText(body.referenceImage));
  const custom = sanitizePromptText(asText(body.customPrompt) || asText(body.avatarPrompt), 1000);
  const appearance = sanitizePromptText(asText(body.appearance), 400);
  const description = sanitizePromptText(asText(body.description), 240);
  const cover = body.roleplayMode === "world" || body.roleplayMode === "group";

  if (cover) {
    const subject = body.roleplayMode === "group" ? "a story with several characters" : "a roleplay setting";
    const scene = custom || description;
    return [
      COVER_STYLE_PROMPT[style],
      `Story cover art for ${subject}.`,
      withReference ? COVER_REFERENCE : "",
      scene ? `Scene: ${sentence(scene)}` : "",
      appearance ? `Visual details: ${sentence(appearance)}` : "",
      COVER_FRAMING,
      COVER_CONSTRAINTS,
    ].filter(Boolean).join(" ");
  }

  // With no visual input at all the name is the only hint (for example, gender); the no-text rule still applies.
  const name = sanitizePromptText(asText(body.name), 80);
  const subject = withReference
    ? PORTRAIT_REFERENCE
    : custom || appearance || description
      ? "A single original character."
      : `A single original character named ${name || "without a name"}.`;

  // A user-written prompt stays the main description, as before; framing then applies only by default.
  const details = custom
    ? [`Image description: ${sentence(custom)}`, `Unless described otherwise, frame it as ${PORTRAIT_FRAMING}.`]
    : [
        appearance ? `Appearance: ${sentence(appearance)}` : "",
        description ? `Character context: ${sentence(description)}` : "",
        `Framing: ${PORTRAIT_FRAMING}.`,
        PORTRAIT_BACKGROUND,
      ];

  return [STYLE_PROMPT[style], subject, ...details, PORTRAIT_CONSTRAINTS].filter(Boolean).join(" ");
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
