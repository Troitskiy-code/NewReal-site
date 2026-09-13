export function toCardImageUrl(characterId: string, imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  if (imageUrl.startsWith("data:")) return `/api/characters/${characterId}/avatar`;
  return imageUrl;
}

export function stripInlineUserImage(image: string | null | undefined): string | null {
  if (!image || image.startsWith("data:")) return null;
  return image;
}
