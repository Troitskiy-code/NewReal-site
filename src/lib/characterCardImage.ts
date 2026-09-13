export function avatarVersion(updatedAt: Date | string | number | null | undefined): string | null {
  if (updatedAt == null) return null;
  const time = new Date(updatedAt).getTime();
  return Number.isFinite(time) ? String(time) : null;
}

export function characterAvatarPath(
  characterId: string,
  updatedAt?: Date | string | number | null
): string {
  const version = avatarVersion(updatedAt);
  const path = `/api/characters/${characterId}/avatar`;
  return version ? `${path}?v=${version}` : path;
}

export function toCardImageUrl(
  characterId: string,
  imageUrl: string | null | undefined,
  updatedAt?: Date | string | number | null
): string | null {
  if (!imageUrl) return null;
  if (!imageUrl.startsWith("data:")) return imageUrl;
  return characterAvatarPath(characterId, updatedAt);
}

export function stripInlineUserImage(image: string | null | undefined): string | null {
  if (!image || image.startsWith("data:")) return null;
  return image;
}
