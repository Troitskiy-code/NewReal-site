/** Countries where NSFW toggle and content are restricted */
export const NSFW_RESTRICTED_COUNTRIES = ["RU", "BY", "KZ"] as const;

export const NSFW_STORAGE_KEY = "newreal_show_nsfw";

export function isRestrictedCountry(countryCode: string | null | undefined): boolean {
  if (!countryCode) return false;
  return NSFW_RESTRICTED_COUNTRIES.includes(countryCode.toUpperCase() as (typeof NSFW_RESTRICTED_COUNTRIES)[number]);
}

export function getRestrictNsfwFromRequest(req: Request): boolean {
  return req.headers.get("x-restrict-nsfw") === "true";
}

export function parseShowNsfwParam(value: string | null): boolean {
  return value === "true";
}

export function resolveCanShowNsfw(isAuthenticated: boolean, restrictNsfw: boolean): boolean {
  return isAuthenticated && !restrictNsfw;
}

export function shouldIncludeNsfwCharacters(options: {
  isAuthenticated: boolean;
  restrictNsfw: boolean;
  showNsfwRequested: boolean;
  isOwnProfile: boolean;
}): boolean {
  if (options.isOwnProfile) return true;
  if (!resolveCanShowNsfw(options.isAuthenticated, options.restrictNsfw)) return false;
  return options.showNsfwRequested;
}
