import { withoutChatThoughts } from "./chatMessageMarkup";
import type { StoryAmbience } from "./storyAmbience";

/** Background music themes, chosen by the mood of the current scene. Files live in public/music. */
export const SCENE_MOODS = ["romance", "sadness", "mystery", "tension", "battle", "adventure", "cozy", "joy", "tavern", "party"] as const;
export type SceneMood = typeof SCENE_MOODS[number];

export const SCENE_MOOD_TAKES: Record<SceneMood, readonly string[]> = {
  romance: ["a", "b", "c"], sadness: ["a", "b"], mystery: ["a", "b", "c"], tension: ["a", "b"], battle: ["a", "b"],
  adventure: ["a", "b"], cozy: ["a", "b"], joy: ["a", "b"], tavern: ["a", "b"], party: ["a", "b"],
};

export function isSceneMood(value: unknown): value is SceneMood {
  return typeof value === "string" && (SCENE_MOODS as readonly string[]).includes(value);
}

export function sceneMusicSrc(mood: SceneMood, take: string) {
  return `/music/${mood}-${take}.mp3`;
}

/**
 * Only continuous sound beds remain. Rooms at home, offices and libraries play music alone: a ticking
 * clock or a keyboard pulled attention away from the music.
 */
export type SceneBed = "rain" | "forest" | "city" | "shore" | "tavern" | "crowd";
const BEDS: Partial<Record<StoryAmbience, SceneBed>> = {
  rain: "rain", forest: "forest", city: "city", shore: "shore", tavern: "tavern", cafe: "crowd", club: "crowd", store: "crowd",
};

export function sceneBed(place: StoryAmbience | null): SceneBed | null {
  return place ? BEDS[place] ?? null : null;
}

export const SCENE_MOOD_MESSAGE_LIMIT = 3;
export const SCENE_MOOD_MESSAGE_CHARS = 1200;

export function parseSceneMood(raw: unknown): SceneMood | null {
  if (typeof raw !== "string") return null;
  const match = /"mood"\s*:\s*"([a-z]+)"/.exec(raw) ?? /^\s*([a-z]+)\s*$/.exec(raw);
  return match && isSceneMood(match[1]) ? match[1] : null;
}

/** Keeps only the visible text of the last few turns, so private thoughts never reach the classifier. */
export function sceneMoodMaterial(texts: unknown): string[] | null {
  if (!Array.isArray(texts) || !texts.length || texts.length > SCENE_MOOD_MESSAGE_LIMIT) return null;
  const visible = texts.map(text => typeof text === "string" ? withoutChatThoughts(text).trim().slice(-SCENE_MOOD_MESSAGE_CHARS) : "");
  return visible.every(Boolean) ? visible : null;
}
