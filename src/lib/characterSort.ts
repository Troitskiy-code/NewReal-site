export const CHARACTER_SORT_OPTIONS = [
  { id: "top", label: "Топ" },
  { id: "random", label: "Рандом" },
  { id: "new", label: "Новинки" },
  { id: "for-you", label: "Для тебя" },
] as const;

export type CharacterSort = (typeof CHARACTER_SORT_OPTIONS)[number]["id"];

export const DEFAULT_CHARACTER_SORT: CharacterSort = "top";

export function isCharacterSort(value: string | null): value is CharacterSort {
  return CHARACTER_SORT_OPTIONS.some((option) => option.id === value);
}
