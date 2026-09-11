export const CHARACTERS_PAGE_LIMIT_MOBILE = 24;
export const CHARACTERS_PAGE_LIMIT_DESKTOP = 25;
export const CHARACTERS_DESKTOP_MEDIA = "(min-width: 768px)";

/** Fallback / profile lists. Home and gallery pick 24 or 25 from viewport. */
export const CHARACTERS_PAGE_LIMIT = CHARACTERS_PAGE_LIMIT_MOBILE;

export const CHARACTERS_PAGE_LIMIT_MAX = 50;

export function getCharactersPageLimit(isDesktop: boolean): number {
  return isDesktop ? CHARACTERS_PAGE_LIMIT_DESKTOP : CHARACTERS_PAGE_LIMIT_MOBILE;
}

export function clampCharactersPageLimit(value: number, fallback = CHARACTERS_PAGE_LIMIT): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(CHARACTERS_PAGE_LIMIT_MAX, Math.max(1, Math.trunc(value)));
}
