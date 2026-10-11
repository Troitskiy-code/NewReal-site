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

// Universe images show the place itself. Words like "cover art" made models put an oversized hero
// in front of a tiny city (a "cinematic cyberpunk world" request returned a portrait), so they are avoided.
const WORLD_STYLE_PROMPT: Record<AvatarStyle, string> = {
  anime: "Anime film background art: a detailed environment painting with clean lines, rich colors and atmospheric lighting.",
  realistic: "Cinematic photorealistic wide shot with natural light, atmospheric perspective and depth.",
};

const GROUP_STYLE_PROMPT: Record<AvatarStyle, string> = {
  anime: "Anime-style illustration with clean line art, rich colors and atmospheric lighting.",
  realistic: "Photorealistic cinematic illustration with natural light and atmospheric depth.",
};

// Cards crop the 3:4 image to 2:3 and the character page to a wide frame anchored near the top,
// so the face has to sit in the upper third with some headroom.
const PORTRAIT_FRAMING =
  "a waist-up character portrait, centered, with the face in the upper third of the frame and some space above the head, looking at the viewer";
const PORTRAIT_BACKGROUND = "Background: a simple atmospheric setting that fits the character, softly out of focus.";
const WORLD_COMPOSITION =
  "Show the place itself: landscape, architecture, streets and atmosphere, in a wide view with depth and a clear sense of scale, seen from eye level or slightly above. The place is the subject, not a person: no close-up characters and no portraits; people may appear only as small figures within the scene at realistic scale. Keep the most striking element in the upper half of the frame.";
const GROUP_COMPOSITION =
  "Show the characters together in their setting in a medium-wide shot. Every character is at natural human scale relative to the others and to the surroundings, with no single oversized figure in the foreground. Keep the faces in the upper half of the frame.";

// Names stay out of the prompt: both models render text well and would print them,
// and a famous name can pull in a real person's face.
const PORTRAIT_CONSTRAINTS =
  "Tasteful and non-explicit, fully clothed. Exactly one character. No text, letters, captions, logos, watermarks or frames.";
const COVER_CONSTRAINTS = "Tasteful and non-explicit. No text, letters, titles, captions, logos, watermarks or frames.";

// Without this, the editing model tends to retouch the uploaded photo instead of drawing the character.
const PORTRAIT_REFERENCE =
  "Use the person in the reference image as the character's likeness: keep the face, facial proportions, hairstyle and distinctive features recognizable. Create a new portrait rather than editing the photo, and do not copy its background, framing, pose or lighting.";
const WORLD_REFERENCE =
  "Use the reference image as inspiration for the look and mood of the place, but create a new image rather than editing the photo.";
const GROUP_REFERENCE =
  "Use the reference image for the look of one of the characters, but create a new scene rather than editing the photo.";

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
  // Each editor gets its own composition: a portrait, a view of a place, or an ensemble scene.
  if (body.roleplayMode === "world" || body.roleplayMode === "group") {
    const world = body.roleplayMode === "world";
    const scene = custom || description;
    return [
      (world ? WORLD_STYLE_PROMPT : GROUP_STYLE_PROMPT)[style],
      world ? "An establishing view of a fictional world for a roleplay story." : "An ensemble illustration for a story with several characters.",
      withReference ? (world ? WORLD_REFERENCE : GROUP_REFERENCE) : "",
      scene ? `${world ? "The world" : "Scene"}: ${sentence(scene)}` : "",
      appearance ? `Visual details: ${sentence(appearance)}` : "",
      world ? WORLD_COMPOSITION : GROUP_COMPOSITION,
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
