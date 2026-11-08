export const STORY_SCENE_SCOPE_PREFIX = "story:";
export const STORY_SCENE_PRICE_VC = 60;
export type StorySceneQuote = { priceVC: number; verseCoins: number };

export function storySceneScope(threadId: string) {
  return `${STORY_SCENE_SCOPE_PREFIX}${threadId}`;
}

export function storySceneThreadId(scope: string) {
  return /^story:([A-Za-z0-9_-]{1,64})$/.exec(scope)?.[1] ?? null;
}

export function storySceneImagePath(threadId: string, jobId: string) {
  return `/api/story-scene-media/${threadId}/${jobId}`;
}

export function isStorySceneJobId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
}
