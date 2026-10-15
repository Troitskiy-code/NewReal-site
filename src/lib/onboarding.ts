/** "Первый шаг": shared by the picker UI, its API and the "for you" ranking. No server imports. */
import { parseTagsString } from "./characterTags";

export const ART_STYLES = ["anime", "realistic"] as const;
export type ArtStyle = (typeof ART_STYLES)[number];
export type OnboardingStyle = ArtStyle | "any";
export type OnboardingGender = "male" | "female";

/** Plain-language interests; each one expands into canonical catalog tags, storage is unchanged. */
export const ONBOARDING_INTERESTS = [
  { id: "romance", tags: ["Романтика", "Медленное развитие отношений", "Флиртующий", "Партнёр"] },
  { id: "fantasy", tags: ["Фэнтези", "Магическая академия", "Средневековье", "Эльф"] },
  { id: "adventure", tags: ["Приключение", "Исследование мира", "Экшен", "Постапокалипсис"] },
  { id: "mystic", tags: ["Мистика", "Ужасы", "Готика"] },
  { id: "detective", tags: ["Детектив", "Триллер"] },
  { id: "scifi", tags: ["Научная фантастика", "Киберпанк", "Космос", "Андроид"] },
  { id: "everyday", tags: ["Повседневность", "Современный мир", "Сосед", "Друг"] },
  { id: "drama", tags: ["Драма", "Выборы и последствия"] },
  { id: "comedy", tags: ["Комедия", "Ироничный"] },
] as const;
export type OnboardingInterest = (typeof ONBOARDING_INTERESTS)[number]["id"];
export const MAX_ONBOARDING_INTERESTS = 3;
export const ONBOARDING_GENDER_TAGS: Record<OnboardingGender, string> = { male: "Мужской персонаж", female: "Женский персонаж" };

export const ONBOARDING_COOKIE = "nv_onboarding";
export const ONBOARDING_COMPLETED_MAX_AGE = 180 * 86400;
// A skip is a "not now", not a "never": the picker may come back after a month.
export const ONBOARDING_SKIPPED_MAX_AGE = 30 * 86400;

export type OnboardingStatus = "completed" | "skipped";
export type OnboardingPrefs = {
  status: OnboardingStatus;
  style: OnboardingStyle | null;
  interests: OnboardingInterest[];
  gender: OnboardingGender | null;
};

const interestIds = new Set<string>(ONBOARDING_INTERESTS.map(item => item.id));
export const isOnboardingInterest = (value: unknown): value is OnboardingInterest => typeof value === "string" && interestIds.has(value);
export const parseArtStyle = (value: unknown): ArtStyle | null => value === "anime" || value === "realistic" ? value : null;
export const parseOnboardingStyle = (value: unknown): OnboardingStyle | null => value === "any" ? "any" : parseArtStyle(value);
export const parseOnboardingGender = (value: unknown): OnboardingGender | null => value === "male" || value === "female" ? value : null;

export function parseOnboardingInterests(value: unknown): OnboardingInterest[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,.]/) : [];
  return [...new Set(items.map(item => String(item).trim()).filter(isOnboardingInterest))].slice(0, MAX_ONBOARDING_INTERESTS);
}

/** Cookie value "1.completed.anime.romance-fantasy.male": URL-safe, no JSON or personal data. */
export function serializeOnboardingPrefs(prefs: OnboardingPrefs): string {
  return ["1", prefs.status, prefs.style ?? "-", prefs.interests.join("-") || "-", prefs.gender ?? "-"].join(".");
}
export function parseOnboardingPrefs(raw: string | null | undefined): OnboardingPrefs | null {
  if (!raw || raw.length > 200) return null;
  const [version, status, style, interests, gender] = decodeURIComponent(raw).split(".");
  if (version !== "1" || (status !== "completed" && status !== "skipped")) return null;
  return { status, style: parseOnboardingStyle(style), interests: parseOnboardingInterests(interests?.split("-") ?? []), gender: parseOnboardingGender(gender) };
}

export const hasOnboardingSignals = (prefs: OnboardingPrefs | null): prefs is OnboardingPrefs =>
  Boolean(prefs && ((prefs.style && prefs.style !== "any") || prefs.interests.length || prefs.gender));

export function onboardingInterestTags(interests: readonly OnboardingInterest[]): string[] {
  return [...new Set(interests.flatMap(id => ONBOARDING_INTERESTS.find(item => item.id === id)?.tags ?? []))];
}
export function matchedOnboardingInterests(tags: string | null | undefined, interests: readonly OnboardingInterest[]): OnboardingInterest[] {
  const own = new Set(parseTagsString(tags));
  return interests.filter(id => ONBOARDING_INTERESTS.find(item => item.id === id)?.tags.some(tag => own.has(tag)));
}

/** Stored style wins; until a card is classified the "Аниме" tag is the only reliable hint. */
export function resolveArtStyle(artStyle: string | null | undefined, tags: string | null | undefined): ArtStyle | null {
  return parseArtStyle(artStyle) ?? (parseTagsString(tags).includes("Аниме") ? "anime" : null);
}
