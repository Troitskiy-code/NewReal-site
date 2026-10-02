export function coinsCharacterId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
}

export function coinsChatHref(characterId: unknown): string | null {
  const id = coinsCharacterId(characterId);
  return id ? `/chat/${id}` : null;
}

export function coinsHrefFromChat(pathname: string): string {
  const match = pathname.match(/^\/(?:ru\/|en\/)?chat\/([a-zA-Z0-9_-]{1,100})\/?$/);
  return match ? `/coins?characterId=${encodeURIComponent(match[1])}` : "/coins";
}
