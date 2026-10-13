import { prisma } from "@/lib/prisma";
import { roleplayMode, validateGroupConfig, type RoleplayMode } from "./roleplayConfig";
import { threadPromptScopeKey, type ChatScope } from "./chatThreads";
export type PromptState = { builderVersion: number; mode: RoleplayMode };
export class GroupPromptUnavailableError extends Error {
  constructor() { super("В карточке отсутствует заполненный состав группы. Владелец должен восстановить участников или вы можете сменить тип истории."); }
}
export function assertPromptStateAvailable(state: PromptState, config?: unknown): void {
  if (state.mode === "group") {
    try { validateGroupConfig(state.mode, config); } catch { throw new GroupPromptUnavailableError(); }
  }
}
export function initialPromptState(card: { roleplayMode?: string | null }): PromptState {
  return { builderVersion: 2, mode: roleplayMode(card.roleplayMode) };
}
export async function getOrCreatePromptState(scopeKey: string, characterId: string): Promise<PromptState> {
  const where = { scopeKey_characterId: { scopeKey, characterId } };
  const existing = await prisma.chatPromptState.findUnique({ where });
  if (existing?.builderVersion === 2) return { builderVersion: 2, mode: roleplayMode(existing.mode) };
  return prisma.$transaction(async tx => {
    // Type changes and first-state creation use one current card snapshot.
    const cards = await tx.$queryRaw<{ roleplayMode: string }[]>`
      SELECT "roleplayMode" FROM "Character" WHERE "id" = ${characterId} FOR SHARE`;
    if (!cards[0]) throw new Error("Character not found");
    const current = await tx.chatPromptState.findUnique({ where });
    if (current) {
      const state = current.builderVersion === 2 ? current
        : await tx.chatPromptState.update({ where, data: { builderVersion: 2 } });
      return { builderVersion: 2, mode: roleplayMode(state.mode) };
    }
    const initial = initialPromptState(cards[0]);
    // Concurrent first requests preserve the first inserted type.
    const state = await tx.chatPromptState.upsert({ where, create: { scopeKey, characterId, ...initial }, update: {} });
    return { builderVersion: 2, mode: roleplayMode(state.mode) };
  });
}
/** Every story keeps its own type ("thread:<id>"); a new story starts from the card's type. */
export async function getOrCreateThreadPromptState(scope: ChatScope): Promise<PromptState> {
  return getOrCreatePromptState(threadPromptScopeKey(scope.threadId), scope.characterId);
}
