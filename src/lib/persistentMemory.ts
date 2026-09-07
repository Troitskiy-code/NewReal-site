export const MEMORY_CONTENT_LIMIT = 10000;

export const WORLD_EVENT_TYPES = ["conversation", "action", "discovery", "travel"] as const;
export type WorldEventType = (typeof WORLD_EVENT_TYPES)[number];

export type MemoryContent = {
  content: string;
};

export type MemoryPermissions = {
  privateAccessUserIds: string[];
};

export function isWorldEventType(value: unknown): value is WorldEventType {
  return typeof value === "string" && (WORLD_EVENT_TYPES as readonly string[]).includes(value);
}

export function memoryToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && "content" in value) {
    const content = (value as { content: unknown }).content;
    if (typeof content === "string") return content;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

export function textToMemoryJson(text: string): MemoryContent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length > MEMORY_CONTENT_LIMIT) {
    throw new Error(`Поле превышает лимит ${MEMORY_CONTENT_LIMIT} символов`);
  }
  return { content: trimmed };
}

export function parseMemoryInput(value: unknown): MemoryContent | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return textToMemoryJson(value);
  if (typeof value === "object") {
    if ("content" in value) {
      const content = (value as { content: unknown }).content;
      if (content === null || content === undefined) return null;
      if (typeof content !== "string") {
        throw new Error("Некорректный формат памяти");
      }
      return textToMemoryJson(content);
    }
    throw new Error("Некорректный формат памяти");
  }
  throw new Error("Некорректный формат памяти");
}

export function parseMemoryPermissionsInput(value: unknown): MemoryPermissions | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object") {
    throw new Error("Некорректные разрешения памяти");
  }

  const obj = value as Record<string, unknown>;
  const ids = new Set<string>();

  if (obj.privateAccessUserIds !== undefined) {
    if (!Array.isArray(obj.privateAccessUserIds)) {
      throw new Error("privateAccessUserIds должен быть массивом");
    }
    for (const id of obj.privateAccessUserIds) {
      if (typeof id === "string" && id.trim()) {
        ids.add(id.trim());
      }
    }
  }

  return { privateAccessUserIds: [...ids] };
}

export function normalizeMemoryPermissions(value: unknown): MemoryPermissions {
  const parsed = parseMemoryPermissionsInput(value);
  if (!parsed) return { privateAccessUserIds: [] };
  return parsed;
}

export function canReadPrivateMemory(
  permissions: unknown,
  ownerId: string,
  viewerId: string | null | undefined
): boolean {
  if (!viewerId) return false;
  if (viewerId === ownerId) return true;
  return normalizeMemoryPermissions(permissions).privateAccessUserIds.includes(viewerId);
}

export function applyPermissionGrant(
  current: unknown,
  body: Record<string, unknown>
): MemoryPermissions {
  const hasList = body.privateAccessUserIds !== undefined;
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";

  if (!hasList && !userId) {
    throw new Error("Укажите privateAccessUserIds или userId");
  }

  const next = normalizeMemoryPermissions(
    hasList ? { privateAccessUserIds: body.privateAccessUserIds } : current
  );
  const ids = new Set(next.privateAccessUserIds);

  if (userId) {
    const canReadPrivate = body.canReadPrivate;
    if (canReadPrivate === false) {
      ids.delete(userId);
    } else if (canReadPrivate === true || canReadPrivate === undefined) {
      ids.add(userId);
    } else {
      throw new Error("canReadPrivate должен быть boolean");
    }
  }

  return { privateAccessUserIds: [...ids] };
}

export function buildInitialPublicMemory(name: string, description: string | null): MemoryContent {
  const trimmedName = name.trim();
  const trimmedDescription = description?.trim();
  const content = trimmedDescription ? `${trimmedName}. ${trimmedDescription}` : trimmedName;
  return { content };
}

export function sanitizeCharacterMemory<T extends {
  userId: string;
  privateMemory?: unknown;
  publicMemory?: unknown;
  memoryPermissions?: unknown;
}>(character: T, viewerId: string | null | undefined) {
  const isOwner = Boolean(viewerId && viewerId === character.userId);
  const canReadPrivate = canReadPrivateMemory(character.memoryPermissions, character.userId, viewerId);

  return {
    ...character,
    publicMemory: character.publicMemory ?? null,
    privateMemory: canReadPrivate ? character.privateMemory ?? null : null,
    memoryPermissions: isOwner ? character.memoryPermissions ?? null : null,
  };
}
