import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isTelegramContext } from "./context";

// Telegram catalog: only characters the owner approved (TelegramCatalogEntry) are visible in the
// Telegram context. The author always sees their own characters. Outside Telegram nothing changes.

/** Prisma condition for listings, or null outside the Telegram context. */
export async function telegramCharacterWhere(viewerId: string | null | undefined): Promise<Prisma.CharacterWhereInput | null> {
  if (!(await isTelegramContext())) return null;
  return viewerId
    ? { OR: [{ telegramCatalogEntry: { isNot: null } }, { userId: viewerId }] }
    : { telegramCatalogEntry: { isNot: null } };
}

/** Adds the Telegram condition to an existing where (AND), unchanged outside Telegram. */
export async function withTelegramCharacterWhere<T extends Prisma.CharacterWhereInput>(
  where: T,
  viewerId: string | null | undefined
): Promise<T | Prisma.CharacterWhereInput> {
  const telegram = await telegramCharacterWhere(viewerId);
  return telegram ? { AND: [where, telegram] } : where;
}

/** Direct access (page, chat, avatar): false hides the character as if it did not exist. */
export async function isCharacterAllowedInTelegram(
  character: { id: string; userId: string },
  viewerId: string | null | undefined
): Promise<boolean> {
  if (!(await isTelegramContext())) return true;
  if (viewerId && viewerId === character.userId) return true;
  const entry = await prisma.telegramCatalogEntry.findUnique({ where: { characterId: character.id }, select: { characterId: true } });
  return Boolean(entry);
}

/** Character ids visible in the current context (unchanged outside Telegram). */
export async function telegramVisibleCharacterIds(ids: string[], viewerId: string | null | undefined): Promise<string[]> {
  const telegram = await telegramCharacterWhere(viewerId);
  if (!telegram || ids.length === 0) return ids;
  const rows = await prisma.character.findMany({ where: { AND: [{ id: { in: ids } }, telegram] }, select: { id: true } });
  const visible = new Set(rows.map((row) => row.id));
  return ids.filter((id) => visible.has(id));
}
