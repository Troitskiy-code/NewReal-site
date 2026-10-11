import { prisma } from "@/lib/prisma";
import { roleplayMode, type RoleplayMode } from "./roleplayConfig";

export function isPromptV2Enabled(): boolean {
  return ["1", "true"].includes((process.env['RP_PROMPT_V2_ENABLED'] ?? "").trim().toLowerCase());
}
export type PromptState = { builderVersion: number; mode: RoleplayMode };
export function initialPromptState(card: { promptBuilderVersion?: number; roleplayMode?: string | null }, hasHistory: boolean): PromptState {
  // Existing history is grandfathered into v1; never infer GM mode from an unknown prompt.
  return hasHistory ? { builderVersion: 1, mode: "character" }
    : { builderVersion: card.promptBuilderVersion === 2 ? 2 : 1, mode: roleplayMode(card.roleplayMode) };
}
export async function getOrCreatePromptState(scopeKey: string, characterId: string, card: { promptBuilderVersion?: number; roleplayMode?: string | null }): Promise<PromptState> {
  const where = { scopeKey_characterId: { scopeKey, characterId } };
  const existing = await prisma.chatPromptState.findUnique({ where });
  if (existing) return { builderVersion: existing.builderVersion, mode: roleplayMode(existing.mode) };
  const hasHistory = scopeKey.startsWith("user:")
    ? !!(await prisma.message.findFirst({ where: { userId: scopeKey.slice(5), characterId }, select: { id: true } }))
    : !!(await prisma.anonymousMessage.findFirst({ where: { sessionId: scopeKey.slice(6), characterId }, select: { id: true } }));
  const initial = initialPromptState(card, hasHistory);
  // Empty update makes the first successful insert authoritative across concurrent requests.
  const state = await prisma.chatPromptState.upsert({ where, create: { scopeKey, characterId, ...initial }, update: {} });
  return { builderVersion: state.builderVersion, mode: roleplayMode(state.mode) };
}
