export type CharacterActivity = {
  description: string | null;
  location: string | null;
  timestamp: string | Date | null;
};

const LOCATION_PATTERN =
  /(?:сейчас\s+)?(?:находится\s+)?в(?:о)?\s+([а-яёa-z0-9][\wа-яё'"«»\s-]{1,40}?)(?:[.!,;:]|$)/i;

export function extractLocation(text: string): string | null {
  const match = text.match(LOCATION_PATTERN);
  const location = match?.[1]?.trim().replace(/[»"]+$/g, "");
  if (!location || location.length < 2) return null;
  return location;
}

export function toIsoDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

export function formatCharacterStatus(
  name: string,
  activity: CharacterActivity | null | undefined
): string | null {
  if (!activity) return null;

  const location = activity.location?.trim();
  if (location) {
    return `${name} сейчас в ${location}`;
  }

  const description = activity.description?.trim().replace(/\s+/g, " ");
  if (!description) return null;

  if (description.length <= 90) return description;
  return `${description.slice(0, 87)}…`;
}
