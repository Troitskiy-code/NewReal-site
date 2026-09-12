export const DEFAULT_AVATAR_MODEL_ID = "flux-kontext" as const;

export const AVATAR_MODELS = [
  {
    id: "flux-kontext",
    name: "FLUX Kontext",
    description: "Фотореализм, сохранение внешности персонажа",
    apiModel: "flux-kontext-pro-t2i",
    apiModelI2i: "flux-kontext-pro-i2i",
    costMultiplier: 1,
  },
  {
    id: "grok-imagine",
    name: "Grok Imagine",
    description: "Быстрая генерация в любом стиле (аниме, реализм, арт)",
    apiModel: "grok-imagine-t2i",
    apiModelI2i: "grok-imagine-i2i",
    costMultiplier: 1,
  },
  {
    id: "gpt-image",
    name: "GPT Image 2.5",
    description: "Сложные сцены, точное следование промпту, работа с текстом",
    apiModel: "gpt-image2-t2i",
    apiModelI2i: "gpt-image2-i2i",
    costMultiplier: 1.5,
  },
  {
    id: "nano-banana-2-lite",
    name: "Nano Banana 2 Lite",
    description: "Быстрая генерация с высокой детализацией. Хорошо справляется с аниме, реализмом и стилизацией.",
    apiModel: "nano-banana-2",
    apiModelI2i: "nano-banana-2",
    costMultiplier: 1,
  },
] as const;

export type AvatarModel = (typeof AVATAR_MODELS)[number];
export type AvatarModelId = AvatarModel["id"];

const LAST_MODEL_STORAGE_KEY = "newverse.avatarModel.last";

export function isAvatarModelId(value: unknown): value is AvatarModelId {
  return AVATAR_MODELS.some((model) => model.id === value);
}

export function getAvatarModel(modelId?: unknown): AvatarModel {
  if (isAvatarModelId(modelId)) {
    const match = AVATAR_MODELS.find((model) => model.id === modelId);
    if (match) return match;
  }
  return AVATAR_MODELS.find((model) => model.id === DEFAULT_AVATAR_MODEL_ID) ?? AVATAR_MODELS[0];
}

export function resolveCreateyaAvatarModel(modelId: unknown, hasReference: boolean): string {
  const model = getAvatarModel(modelId);
  return hasReference ? model.apiModelI2i : model.apiModel;
}

export function avatarModelStorageKey(characterId?: string): string {
  return characterId ? `newverse.avatarModel.${characterId}` : "newverse.avatarModel.new";
}

export function readStoredAvatarModelId(characterId?: string): AvatarModelId {
  if (typeof window === "undefined") return DEFAULT_AVATAR_MODEL_ID;
  try {
    const stored = window.localStorage.getItem(avatarModelStorageKey(characterId));
    if (isAvatarModelId(stored)) return stored;
    const last = window.localStorage.getItem(LAST_MODEL_STORAGE_KEY);
    if (isAvatarModelId(last)) return last;
  } catch {
    /* ignore quota / private mode */
  }
  return DEFAULT_AVATAR_MODEL_ID;
}

export function storeAvatarModelId(modelId: AvatarModelId, characterId?: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(avatarModelStorageKey(characterId), modelId);
    window.localStorage.setItem(LAST_MODEL_STORAGE_KEY, modelId);
  } catch {
    /* ignore quota / private mode */
  }
}
