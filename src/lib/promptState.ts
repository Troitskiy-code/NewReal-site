import { prisma } from "@/lib/prisma";
import { roleplayMode, validateGroupConfig, type RoleplayMode } from "./roleplayConfig";
import { migratedInitialState, promptRolloutEnabled } from "./promptRolloutPolicy";

export function isPromptV2Enabled(): boolean {
  return promptRolloutEnabled();
}
export type PromptState = { builderVersion: number; mode: RoleplayMode };
export class GroupPromptUnavailableError extends Error {
  constructor(reason: "disabled" | "roster" = "disabled") { super(reason === "roster" ? "В карточке отсутствует заполненный состав группы. Владелец должен восстановить участников или вы можете явно сменить режим истории." : "Групповой чат требует включённой новой сборки и версии 2 этой истории"); }
}
export function assertPromptStateAvailable(state: PromptState, config?: unknown): void {
  if (state.mode === "group" && (state.builderVersion !== 2 || !isPromptV2Enabled())) throw new GroupPromptUnavailableError();
  if (state.mode === "group") {
    try { validateGroupConfig(state.mode, config); } catch { throw new GroupPromptUnavailableError("roster"); }
  }
}
export function initialPromptState(card: { promptBuilderVersion?: number; roleplayMode?: string | null }, hasHistory: boolean): PromptState {
  // Existing history is grandfathered into v1; never infer GM mode from an unknown prompt.
  return hasHistory ? { builderVersion: 1, mode: "character" }
    : { builderVersion: card.promptBuilderVersion === 2 ? 2 : 1, mode: roleplayMode(card.roleplayMode) };
}
export async function getOrCreatePromptState(scopeKey: string, characterId: string, card: { promptBuilderVersion?: number; roleplayMode?: string | null }): Promise<PromptState> {
  const where = { scopeKey_characterId: { scopeKey, characterId } };
  const existing = await prisma.chatPromptState.findUnique({ where });
  if (existing) return { builderVersion: existing.builderVersion, mode: roleplayMode(existing.mode) };
  if (isPromptV2Enabled()) {
    return prisma.$transaction(async tx => {
      // Serializes first-state creation with admin conversion/rollback of the same card.
      const cards = await tx.$queryRaw<{ promptBuilderVersion: number; roleplayMode: string }[]>`
        SELECT "promptBuilderVersion", "roleplayMode" FROM "Character" WHERE "id" = ${characterId} FOR SHARE`;
      if (!cards[0]) throw new Error("Character not found");
      const current = await tx.chatPromptState.findUnique({ where });
      if (current) return { builderVersion: current.builderVersion, mode: roleplayMode(current.mode) };
      const hasHistory = scopeKey.startsWith("user:")
        ? !!(await tx.message.findFirst({ where: { userId: scopeKey.slice(5), characterId }, select: { id: true } }))
        : !!(await tx.anonymousMessage.findFirst({ where: { sessionId: scopeKey.slice(6), characterId }, select: { id: true } }));
      const initial = await migratedInitialState(tx, characterId, scopeKey, initialPromptState(cards[0], hasHistory), cards[0], hasHistory);
      const state = await tx.chatPromptState.upsert({ where, create: { scopeKey, characterId, ...initial }, update: {} });
      return { builderVersion: state.builderVersion, mode: roleplayMode(state.mode) };
    });
  }
  const hasHistory = scopeKey.startsWith("user:")
    ? !!(await prisma.message.findFirst({ where: { userId: scopeKey.slice(5), characterId }, select: { id: true } }))
    : !!(await prisma.anonymousMessage.findFirst({ where: { sessionId: scopeKey.slice(6), characterId }, select: { id: true } }));
  const initial = initialPromptState(card, hasHistory);
  // Empty update makes the first successful insert authoritative across concurrent requests.
  const state = await prisma.chatPromptState.upsert({ where, create: { scopeKey, characterId, ...initial }, update: {} });
  return { builderVersion: state.builderVersion, mode: roleplayMode(state.mode) };
}
