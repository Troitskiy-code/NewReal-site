export type OwnerModerationView = {
  moderationStatus: string | null;
  moderationReason: string | null;
  moderationWarnedAt: Date | string | null;
};

export function stripModerationFields<T extends object>(character: T) {
  const {
    moderationStatus: _status,
    moderationReason: _reason,
    moderationWarnedAt: _warnedAt,
    violationCount: _count,
    ...rest
  } = character as T & {
    moderationStatus?: unknown;
    moderationReason?: unknown;
    moderationWarnedAt?: unknown;
    violationCount?: unknown;
  };
  return rest;
}

export function ownerModerationFields(
  character: {
    userId: string;
    moderationStatus?: string | null;
    moderationReason?: string | null;
    moderationWarnedAt?: Date | string | null;
  },
  viewerId: string | null | undefined
): OwnerModerationView | Record<string, never> {
  if (!viewerId || viewerId !== character.userId) return {};
  return {
    moderationStatus: character.moderationStatus ?? null,
    moderationReason: character.moderationReason ?? null,
    moderationWarnedAt: character.moderationWarnedAt ?? null,
  };
}
