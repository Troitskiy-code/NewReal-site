// No content-policy wording or word softening here: Kie moderates input itself (a refusal is a refunded
// failure), and telling the image model "non-explicit, fully clothed" pushed it into stiff, over-covered results.

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizePromptText(value: string, maxLength = 280): string {
  const text = value.replace(/\s+/g, " ").trim();
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
export type AvatarPromptMode = "character" | "world" | "group";

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
const PORTRAIT_CONSTRAINTS = "Exactly one character. No text, letters, captions, logos, watermarks or frames.";
const COVER_CONSTRAINTS = "No text, letters, titles, captions, logos, watermarks or frames.";

// Without this, the editing model tends to retouch the uploaded photo instead of drawing the character.
// The face rule opens and closes the prompt: a long scene description in between made the model
// draw a generic attractive face, and "wishes take priority" read as permission to change it.
const REFERENCE_PHOTO =
  "Keep exactly the same person as in the reference image: the same face shape, eyes, nose, mouth, jawline, skin tone, apparent age and any scars or marks, instantly recognizable, and the same hairstyle unless the request below changes it. Do not beautify, slim, de-age or reinterpret the face. Create a new image of this person rather than editing the photo: clothing, pose, setting and lighting may change.";
const REFERENCE_DRAWN =
  "Draw the person from the reference image as this character: keep the face shape, facial proportions, hairstyle and distinctive features recognizable, and the same apparent age. Create a new image rather than editing the photo.";
const REFERENCE_CLOSING = "The face is clearly visible and is unmistakably the same person as in the reference image.";
const WORLD_REFERENCE =
  "Use the reference image as inspiration for the look and mood of the place, but create a new image rather than editing the photo.";
const GROUP_REFERENCE =
  "Use the reference image for the look of one of the characters, but create a new scene rather than editing the photo.";

const portraitReference = (style: AvatarStyle) => style === "anime" ? REFERENCE_DRAWN : REFERENCE_PHOTO;

export function resolveAvatarStyle(value: unknown): AvatarStyle {
  return value === "anime" ? "anime" : "realistic";
}

export function avatarPromptMode(value: unknown): AvatarPromptMode {
  return value === "world" || value === "group" ? value : "character";
}

/**
 * Wraps a written scene description (from the prompt-writer model) in the parts that must never be
 * left to a model: style, reference handling, composition for the editor type and the no-text rules.
 */
export function composeAvatarPrompt({ mode, style, withReference, scene, hasWishes = false }: {
  mode: AvatarPromptMode; style: AvatarStyle; withReference: boolean; scene: string; hasWishes?: boolean;
}): string {
  const description = sentence(sanitizePromptText(scene, 1600));
  if (mode === "world") {
    return [WORLD_STYLE_PROMPT[style], "An establishing view of a fictional world for a roleplay story.",
      withReference ? WORLD_REFERENCE : "", description, WORLD_COMPOSITION, COVER_CONSTRAINTS].filter(Boolean).join(" ");
  }
  if (mode === "group") {
    return [GROUP_STYLE_PROMPT[style], "An ensemble illustration for a story with several characters.",
      withReference ? GROUP_REFERENCE : "", description, GROUP_COMPOSITION, COVER_CONSTRAINTS].filter(Boolean).join(" ");
  }
  // A wish like "full body" must beat the default framing here too.
  const framing = hasWishes ? `Unless the description says otherwise, frame it as ${PORTRAIT_FRAMING}.` : `Framing: ${PORTRAIT_FRAMING}.`;
  if (withReference) return [portraitReference(style), STYLE_PROMPT[style], description, framing, REFERENCE_CLOSING, PORTRAIT_CONSTRAINTS].filter(Boolean).join(" ");
  return [STYLE_PROMPT[style], "A single original character.", description, framing, PORTRAIT_CONSTRAINTS].filter(Boolean).join(" ");
}

/** Deterministic prompt from the editor fields; also the fallback when the prompt writer is off or fails. */
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
  // The editor field is "wishes for the image": it adds to the card and wins on conflict, but no longer
  // replaces the card's description.
  const wishes = sanitizePromptText(asText(body.customPrompt) || asText(body.avatarPrompt), 1000);
  const appearance = sanitizePromptText(asText(body.appearance), 400);
  const description = sanitizePromptText(asText(body.description), 240);
  const requested = wishes ? `Requested details, which take priority: ${sentence(wishes)}` : "";
  // Each editor gets its own composition: a portrait, a view of a place, or an ensemble scene.
  if (body.roleplayMode === "world" || body.roleplayMode === "group") {
    const world = body.roleplayMode === "world";
    return [
      (world ? WORLD_STYLE_PROMPT : GROUP_STYLE_PROMPT)[style],
      world ? "An establishing view of a fictional world for a roleplay story." : "An ensemble illustration for a story with several characters.",
      withReference ? (world ? WORLD_REFERENCE : GROUP_REFERENCE) : "",
      description ? `${world ? "The world" : "Scene"}: ${sentence(description)}` : "",
      appearance ? `Visual details: ${sentence(appearance)}` : "",
      requested,
      world ? WORLD_COMPOSITION : GROUP_COMPOSITION,
      COVER_CONSTRAINTS,
    ].filter(Boolean).join(" ");
  }

  // With no visual input at all the name is the only hint (for example, gender); the no-text rule still applies.
  const name = sanitizePromptText(asText(body.name), 80);
  if (withReference) {
    return [
      portraitReference(style),
      STYLE_PROMPT[style],
      wishes ? `Requested clothing, pose, expression and setting: ${sentence(wishes)}` : "",
      // The card may flatter or contradict the photo ("model looks"); the photo decides the person.
      appearance ? `Other details, only where they do not contradict the reference face: ${sentence(appearance)}` : "",
      description ? `Character context: ${sentence(description)}` : "",
      wishes ? `Unless the request says otherwise, frame it as ${PORTRAIT_FRAMING}.` : `Framing: ${PORTRAIT_FRAMING}.`,
      wishes ? "" : PORTRAIT_BACKGROUND,
      REFERENCE_CLOSING,
      PORTRAIT_CONSTRAINTS,
    ].filter(Boolean).join(" ");
  }
  const subject = wishes || appearance || description
      ? "A single original character."
      : `A single original character named ${name || "without a name"}.`;

  // With wishes, framing and background are defaults the wishes may override ("full body", "night city").
  const details = [
    appearance ? `Appearance: ${sentence(appearance)}` : "",
    description ? `Character context: ${sentence(description)}` : "",
    requested,
    wishes ? `Unless the requested details say otherwise, frame it as ${PORTRAIT_FRAMING}.` : `Framing: ${PORTRAIT_FRAMING}.`,
    wishes ? "" : PORTRAIT_BACKGROUND,
  ];

  return [STYLE_PROMPT[style], subject, ...details, PORTRAIT_CONSTRAINTS].filter(Boolean).join(" ");
}
