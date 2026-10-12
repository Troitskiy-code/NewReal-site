import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseRoleplayFields, validateGroupConfig, ROLEPLAY_MODES, ROLEPLAY_STYLES } from "./roleplayConfig";
import { assembleRoleplayPrompt, fitPromptAssembly, PromptBudgetError } from "./chatSystemPrompt";
import { countTokens } from "./tokenCount";
import { ClientInputError } from "./publicError";
import { promptRolloutEnabled, PROMPT_ROLLOUT_ID } from "./promptRolloutPolicy";
import { infoLog } from "./logger";

export const PROMPT_MIGRATION_BATCH_LIMIT = 5;
export class PromptMigrationConflict extends Error {}
const textLimits = { description: 5000, appearance: 2000, greeting: 2000, scenario: 1500, exampleDialogs: 3000 } as const;
const editable = [...Object.keys(textLimits), "roleplayMode", "roleplayStyle", "rpConfig"];
export const promptMigrationSelect = {
  id: true, userId: true, name: true, name_en: true, description: true, appearance: true, greeting: true,
  scenario: true, exampleDialogs: true, description_en: true, appearance_en: true, greeting_en: true,
  scenario_en: true, exampleDialogs_en: true, systemPrompt: true, legacyPromptArchive: true,
  promptBuilderVersion: true, promptOrigin: true, roleplayMode: true, roleplayStyle: true, rpConfig: true,
} as const;
type Card = Prisma.CharacterGetPayload<{ select: typeof promptMigrationSelect }>;
type Proposal = ReturnType<typeof parseRoleplayFields> & Record<keyof typeof textLimits, string | null>;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export function promptFingerprint(card: unknown) {
  return createHash("sha256").update(JSON.stringify(stable(card))).digest("hex");
}
function json(value: unknown) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
export function preparePromptMigration(card: Card, input: unknown): Proposal {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ClientInputError("Проверьте поля карточки");
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some(key => !editable.includes(key))) throw new ClientInputError("Изменять можно только поля инструкций");
  const merged = { ...card, ...fields };
  if (!ROLEPLAY_MODES.includes(merged.roleplayMode as typeof ROLEPLAY_MODES[number]) ||
    !ROLEPLAY_STYLES.includes(merged.roleplayStyle as typeof ROLEPLAY_STYLES[number])) throw new ClientInputError("Выберите тип и стиль карточки");
  const proposal = parseRoleplayFields({ ...merged, rpConfig: merged.rpConfig ?? {} }) as Proposal;
  for (const [key, limit] of Object.entries(textLimits)) {
    const value = merged[key as keyof typeof textLimits];
    if (value !== null && (typeof value !== "string" || value.length > limit)) throw new ClientInputError(`Поле ${key}: максимум ${limit} символов`);
    proposal[key as keyof typeof textLimits] = typeof value === "string" ? value.trim() || null : null;
  }
  if (!proposal.description) throw new ClientInputError("Заполните характер персонажа или описание истории");
  validateGroupConfig(proposal.roleplayMode, proposal.rpConfig);
  // Everyone, including guests, must be able to assemble the reviewed card on the 6000-token plan.
  for (const locale of ["ru", "en"]) fitPromptAssembly(assembleRoleplayPrompt({ name: card.name, ...proposal }, locale), 3000, countTokens);
  return proposal;
}
function assess(card: Card) {
  try {
    const proposal = preparePromptMigration(card, {});
    const assembly = fitPromptAssembly(assembleRoleplayPrompt({ name: card.name, ...proposal }, "ru"), 3000, countTokens);
    return { valid: true, warnings: [
      ...((card.systemPrompt?.trim() || card.legacyPromptArchive?.trim()) && card.promptBuilderVersion === 1 ? ["Нужно сравнить старый промпт с полями карточки: автоматического переноса смысла нет."] : []),
      ...(assembly.truncatedSources?.length ? ["На базовом тарифе часть длинных описаний сокращается."] : []),
    ] };
  } catch (error) {
    if (error instanceof ClientInputError || error instanceof PromptBudgetError) return { valid: false, warnings: [error.message] };
    throw error;
  }
}
async function lockRollout(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT "id" FROM "PromptRollout" WHERE "id" = ${PROMPT_ROLLOUT_ID} FOR UPDATE`;
  const row = await tx.promptRollout.findUnique({ where: { id: PROMPT_ROLLOUT_ID } });
  if (!row) throw new PromptMigrationConflict("Сначала примените SQL схемы массового перехода");
  return row;
}
async function lockedCard(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "Character" WHERE "id" = ${id} FOR UPDATE`;
  const card = await tx.character.findUnique({ where: { id }, select: promptMigrationSelect });
  if (!card) throw new PromptMigrationConflict("Карточка уже удалена");
  return card;
}
export async function inspectPromptRollout() {
  const [row, total, legacyCards, legacyStates, reviewed, applied] = await Promise.all([
    prisma.promptRollout.findUnique({ where: { id: PROMPT_ROLLOUT_ID } }),
    prisma.character.count(), prisma.character.count({ where: { promptBuilderVersion: { not: 2 } } }),
    prisma.chatPromptState.count({ where: { builderVersion: { not: 2 } } }),
    prisma.promptMigrationEntry.count({ where: { status: "reviewed" } }),
    prisma.promptMigrationEntry.count({ where: { status: "applied" } }),
  ]);
  const enabled = promptRolloutEnabled();
  return { enabled, finalized: enabled && row?.finalized === true && legacyCards === 0 && legacyStates === 0,
    total, legacyCards, legacyStates, reviewed, applied };
}
export async function listPromptMigrationCards(cursor?: string) {
  const cards = await prisma.character.findMany({ select: promptMigrationSelect, orderBy: { id: "asc" }, take: 21,
    ...(cursor ? { where: { id: { gt: cursor } } } : {}) });
  const page = cards.slice(0, 20);
  const entries = await prisma.promptMigrationEntry.findMany({ where: { characterId: { in: page.map(card => card.id) }, status: { in: ["reviewed", "applied"] } },
    orderBy: { reviewedAt: "desc" }, select: { id: true, characterId: true, status: true, sourceFingerprint: true } });
  return { cards: page.map(card => {
    const entry = entries.find(row => row.characterId === card.id && row.status === "applied") ?? entries.find(row => row.characterId === card.id);
    return { id: card.id, name: card.name, version: card.promptBuilderVersion, mode: card.roleplayMode,
      fingerprint: promptFingerprint(card), ...assess(card), entryId: entry?.id ?? null,
      status: entry?.status ?? "unchecked", stale: entry?.status === "reviewed" && entry.sourceFingerprint !== promptFingerprint(card) };
  }), cursor: cards.length > 20 ? page.at(-1)?.id ?? null : null };
}
export async function inspectPromptMigrationCard(id: string) {
  const card = await prisma.character.findUnique({ where: { id }, select: promptMigrationSelect });
  if (!card) throw new PromptMigrationConflict("Карточка не найдена");
  const entries = await prisma.promptMigrationEntry.findMany({ where: { characterId: id, status: { in: ["reviewed", "applied"] } }, orderBy: { reviewedAt: "desc" } });
  const entry = entries.find(item => item.status === "applied") ?? entries[0] ?? null;
  return { card, fingerprint: promptFingerprint(card), assessment: assess(card),
    entry: entry ? { id: entry.id, status: entry.status, proposal: entry.status === "reviewed" && entry.sourceFingerprint === promptFingerprint(card) ? entry.proposal : null } : null,
    legacyStories: await prisma.chatPromptState.count({ where: { characterId: id, builderVersion: { not: 2 } } }),
    stories: await prisma.chatPromptState.count({ where: { characterId: id } }) };
}
export async function reviewPromptMigration(id: string, fingerprint: string, fields: unknown) {
  return prisma.$transaction(async tx => {
    await lockRollout(tx);
    const card = await lockedCard(tx, id);
    if (promptFingerprint(card) !== fingerprint) throw new PromptMigrationConflict("Карточка изменилась. Откройте её заново и повторите проверку");
    if (await tx.promptMigrationEntry.findFirst({ where: { characterId: id, status: "applied" } })) throw new PromptMigrationConflict("Карточка уже переведена. Для нового переноса сначала нужен откат");
    const proposal = preparePromptMigration(card, fields);
    await tx.promptMigrationEntry.updateMany({ where: { characterId: id, status: "reviewed" }, data: { status: "superseded" } });
    const entry = await tx.promptMigrationEntry.create({ data: { characterId: id, sourceFingerprint: fingerprint,
      before: json(card), proposal: json(proposal) } });
    return { entryId: entry.id, status: entry.status };
  }, { timeout: 15000 });
}
export async function promptMigrationQueue(storiesOnly = false) {
  const characterIds = storiesOnly ? (await prisma.chatPromptState.findMany({ where: { builderVersion: { not: 2 } }, distinct: ["characterId"], select: { characterId: true } })).map(row => row.characterId) : [];
  return { entryIds: (await prisma.promptMigrationEntry.findMany({ where: { status: storiesOnly ? "applied" : "reviewed", ...(storiesOnly ? { characterId: { in: characterIds } } : {}) }, orderBy: [{ reviewedAt: "asc" }, { id: "asc" }],
    take: PROMPT_MIGRATION_BATCH_LIMIT, select: { id: true } })).map(row => row.id) };
}
/** Explicitly approved catch-up, distinct from an idempotent apply replay. */
export async function alignPromptMigrationStories(entryId: string, reviewedFingerprint?: string) {
  if (!promptRolloutEnabled()) throw new PromptMigrationConflict("Новая сборка выключена оператором");
  const result = await prisma.$transaction(async tx => {
    await lockRollout(tx);
    const entry = await tx.promptMigrationEntry.findUnique({ where: { id: entryId } });
    if (!entry || entry.status !== "applied") throw new PromptMigrationConflict("Сначала переведите карточку после проверки");
    const card = await lockedCard(tx, entry.characterId);
    if (promptFingerprint(card) !== (reviewedFingerprint ?? entry.afterFingerprint)) throw new PromptMigrationConflict("Карточка изменилась. Откройте её в панели, сравните актуальные поля и отдельно подтвердите согласование историй");
    const proposal = preparePromptMigration(card, reviewedFingerprint ? {} : entry.proposal);
    await tx.$queryRaw`SELECT "id" FROM "ChatPromptState" WHERE "characterId" = ${card.id} FOR UPDATE`;
    const stories = await tx.chatPromptState.findMany({ where: { characterId: card.id, builderVersion: { not: 2 } } });
    for (const story of stories) {
      const snapshot = { builderVersion: story.builderVersion, mode: story.mode, previousMigrationId: story.promptMigrationId === entryId ? null : story.promptMigrationId };
      await tx.promptMigrationStory.upsert({ where: { entryId_scopeKey: { entryId, scopeKey: story.scopeKey } },
        create: { entryId, scopeKey: story.scopeKey, ...snapshot }, update: story.promptMigrationId === entryId ? {} : snapshot });
    }
    await tx.chatPromptState.updateMany({ where: { characterId: card.id, builderVersion: { not: 2 } },
      data: { builderVersion: 2, mode: proposal.roleplayMode, promptMigrationId: entryId } });
    if (reviewedFingerprint) await tx.promptMigrationEntry.update({ where: { id: entryId }, data: { proposal: json(proposal), reviewedAt: new Date() } });
    return { entryId, status: "stories_aligned", stories: stories.length };
  }, { timeout: 15000 });
  infoLog("PromptMigration", "stories aligned", { entryId, count: result.stories });
  return result;
}
export async function applyPromptMigration(entryId: string) {
  if (!promptRolloutEnabled()) throw new PromptMigrationConflict("Сначала включите RP_PROMPT_V2_ENABLED=true для пробной приёмки");
  const result = await prisma.$transaction(async tx => {
    await lockRollout(tx);
    const entry = await tx.promptMigrationEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new PromptMigrationConflict("Проверка карточки не найдена");
    if (entry.status === "applied") return { entryId, status: "already_applied", stories: 0 };
    if (entry.status !== "reviewed") throw new PromptMigrationConflict("Эта проверка больше не актуальна");
    const card = await lockedCard(tx, entry.characterId);
    if (promptFingerprint(card) !== entry.sourceFingerprint) throw new PromptMigrationConflict("Карточка изменилась после проверки. Нужна повторная проверка");
    const proposal = preparePromptMigration(card, entry.proposal);
    // Lock existing stories so a simultaneous explicit user switch cannot lose its version.
    await tx.$queryRaw`SELECT "id" FROM "ChatPromptState" WHERE "characterId" = ${card.id} FOR UPDATE`;
    if (await tx.chatPromptState.findFirst({ where: { characterId: card.id, builderVersion: 2, mode: "group" } })) {
      try { validateGroupConfig("group", proposal.rpConfig); }
      catch { throw new ClientInputError("У карточки есть истории v2 с несколькими персонажами. Сохраните заполненный состав группы, чтобы эти истории продолжили работать."); }
    }
    const stories = await tx.chatPromptState.findMany({ where: { characterId: card.id, builderVersion: { not: 2 } } });
    if (stories.length) await tx.promptMigrationStory.createMany({ data: stories.map(state => ({ entryId, scopeKey: state.scopeKey,
      builderVersion: state.builderVersion, mode: state.mode, previousMigrationId: state.promptMigrationId })) });
    const data: Prisma.CharacterUpdateInput = { ...proposal, rpConfig: json(proposal.rpConfig), promptBuilderVersion: 2,
      legacyPromptArchive: card.legacyPromptArchive ?? card.systemPrompt };
    for (const key of Object.keys(textLimits) as (keyof typeof textLimits)[]) {
      if (proposal[key] !== card[key]) Object.assign(data, { [`${key}_en`]: null });
    }
    const updated = await tx.character.update({ where: { id: card.id }, data, select: promptMigrationSelect });
    await tx.chatPromptState.updateMany({ where: { characterId: card.id, builderVersion: { not: 2 } },
      data: { builderVersion: 2, mode: proposal.roleplayMode, promptMigrationId: entryId } });
    await tx.promptMigrationEntry.update({ where: { id: entryId }, data: { status: "applied", appliedAt: new Date(), afterFingerprint: promptFingerprint(updated) } });
    return { entryId, status: "applied", stories: stories.length };
  }, { timeout: 15000 });
  infoLog("PromptMigration", "card applied", { entryId, status: result.status, count: result.stories });
  return result;
}
export async function rollbackPromptMigration(entryId: string) {
  const result = await prisma.$transaction(async tx => {
    await lockRollout(tx);
    const entry = await tx.promptMigrationEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new PromptMigrationConflict("Перевод не найден");
    if (entry.status === "rolled_back") return { entryId, status: "already_rolled_back", stories: 0 };
    if (entry.status !== "applied") throw new PromptMigrationConflict("Откатывать можно только применённый перевод");
    const card = await lockedCard(tx, entry.characterId);
    if (promptFingerprint(card) !== entry.afterFingerprint) throw new PromptMigrationConflict("После перевода карточку редактировали. Автоматический откат остановлен, чтобы сохранить изменения");
    const before = entry.before as unknown as Card;
    await tx.$queryRaw`SELECT "id" FROM "ChatPromptState" WHERE "characterId" = ${card.id} FOR UPDATE`;
    if (await tx.chatPromptState.findFirst({ where: { characterId: card.id, builderVersion: 2, mode: "group",
      OR: [{ promptMigrationId: null }, { promptMigrationId: { not: entryId } }] } })) {
      try { validateGroupConfig("group", before.rpConfig); }
      catch { throw new PromptMigrationConflict("Есть сохранённые пользователем групповые истории v2, а в исходной карточке нет состава. Сначала владельцам этих историй нужно сменить тип; автоматический откат остановлен."); }
    }
    const { id: _id, userId: _owner, name: _name, name_en: _nameEn, ...restored } = before;
    void _id; void _owner; void _name; void _nameEn;
    await tx.character.update({ where: { id: card.id }, data: { ...restored, rpConfig: restored.rpConfig === null ? Prisma.DbNull : json(restored.rpConfig) } });
    const snapshots = await tx.promptMigrationStory.findMany({ where: { entryId } });
    let restoredStories = 0;
    for (const snapshot of snapshots) {
      const restored = await tx.chatPromptState.updateMany({ where: { characterId: card.id, scopeKey: snapshot.scopeKey, promptMigrationId: entryId },
        data: { builderVersion: snapshot.builderVersion, mode: snapshot.mode, promptMigrationId: snapshot.previousMigrationId } });
      restoredStories += restored.count;
    }
    await tx.promptMigrationEntry.update({ where: { id: entryId }, data: { status: "rolled_back", rolledBackAt: new Date() } });
    await tx.promptRollout.update({ where: { id: PROMPT_ROLLOUT_ID }, data: { finalized: false, finalizedAt: null } });
    return { entryId, status: "rolled_back", stories: restoredStories };
  }, { timeout: 15000 });
  infoLog("PromptMigration", "card rolled back", { entryId, status: result.status, count: result.stories });
  return result;
}
export async function finalizePromptRollout() {
  if (!promptRolloutEnabled()) throw new PromptMigrationConflict("Новая сборка выключена оператором");
  return prisma.$transaction(async tx => {
    await lockRollout(tx);
    const cards = await tx.character.count({ where: { promptBuilderVersion: { not: 2 } } });
    const stories = await tx.chatPromptState.count({ where: { builderVersion: { not: 2 } } });
    if (cards || stories) throw new PromptMigrationConflict(`Остались карточки v1: ${cards}; настройки историй v1: ${stories}`);
    await tx.promptRollout.update({ where: { id: PROMPT_ROLLOUT_ID }, data: { finalized: true, finalizedAt: new Date() } });
    return { finalized: true };
  }, { timeout: 15000 });
}
