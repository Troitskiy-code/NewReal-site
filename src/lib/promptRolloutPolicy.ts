import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { roleplayMode } from "./roleplayConfig";

export const PROMPT_ROLLOUT_ID = "rp-v2";
export function promptRolloutEnabled() {
  return ["true", "1"].includes((process.env['RP_PROMPT_V2_ENABLED'] ?? "").trim().toLowerCase());
}
export async function promptRolloutFinalized(db: Pick<Prisma.TransactionClient, "promptRollout" | "character" | "chatPromptState"> = prisma) {
  if (!promptRolloutEnabled()) return false;
  if ((await db.promptRollout.findUnique({ where: { id: PROMPT_ROLLOUT_ID } }))?.finalized !== true) return false;
  const [cards, stories] = await Promise.all([
    db.character.count({ where: { promptBuilderVersion: { not: 2 } } }),
    db.chatPromptState.count({ where: { builderVersion: { not: 2 } } }),
  ]);
  return cards === 0 && stories === 0;
}
/** Called while holding the Character row lock. No inference from the legacy text. */
export async function migratedInitialState(tx: Prisma.TransactionClient, characterId: string, scopeKey: string,
  initial: { builderVersion: number; mode: string }, card: { promptBuilderVersion: number; roleplayMode: string }, hasHistory: boolean) {
  if (!promptRolloutEnabled()) return initial;
  const entry = await tx.promptMigrationEntry.findFirst({ where: { characterId, status: "applied" } });
  if (entry && card.promptBuilderVersion === 2) {
    const proposal = entry.proposal as { roleplayMode: string };
    const before = entry.before as { promptBuilderVersion: number; roleplayMode: string };
    const previous = hasHistory ? { builderVersion: 1, mode: "character" }
      : { builderVersion: before.promptBuilderVersion === 2 ? 2 : 1, mode: roleplayMode(before.roleplayMode) };
    await tx.promptMigrationStory.upsert({ where: { entryId_scopeKey: { entryId: entry.id, scopeKey } },
      create: { entryId: entry.id, scopeKey, ...previous }, update: {} });
    return { builderVersion: 2, mode: roleplayMode(hasHistory ? proposal.roleplayMode : card.roleplayMode), promptMigrationId: entry.id };
  }
  if (card.promptBuilderVersion === 2 && await promptRolloutFinalized(tx)) {
    return { builderVersion: 2, mode: roleplayMode(card.roleplayMode) };
  }
  return initial;
}
