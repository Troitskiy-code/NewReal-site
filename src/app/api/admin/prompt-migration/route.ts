import { supportAdminAuthorized, supportAdminOriginAllowed } from "@/lib/supportAdmin";
import { ClientInputError } from "@/lib/publicError";
import { PromptBudgetError } from "@/lib/chatSystemPrompt";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { inspectPromptRollout, listPromptMigrationCards, inspectPromptMigrationCard, reviewPromptMigration,
  applyPromptMigration, rollbackPromptMigration, alignPromptMigrationStories, finalizePromptRollout, promptMigrationQueue,
  PromptMigrationConflict, PROMPT_MIGRATION_BATCH_LIMIT } from "@/lib/promptMigration";

export const runtime = "nodejs";
export const maxDuration = 60;
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new ClientInputError("Некорректный идентификатор");
  return value;
}
function failure(error: unknown) {
  if (error instanceof ClientInputError || error instanceof PromptBudgetError) return reply({ error: error.message }, 400);
  if (error instanceof PromptMigrationConflict) return reply({ error: error.message }, 409);
  errorLog("PromptMigration", "operation failed", toSafeDiagnostic(error));
  return reply({ error: "Операция не выполнена. Проверьте миграцию 20261012193000_prompt_bulk_rollout и серверные логи." }, 503);
}
export async function GET(request: Request) {
  if (!supportAdminAuthorized(request)) return reply({ error: "Нет доступа" }, 401);
  try {
    const query = new URL(request.url).searchParams;
    const action = query.get("action") ?? "status";
    if (action === "status") return reply(await inspectPromptRollout());
    if (action === "list") return reply(await listPromptMigrationCards(query.has("cursor") ? id(query.get("cursor")) : undefined));
    if (action === "detail") return reply(await inspectPromptMigrationCard(id(query.get("characterId"))));
    if (action === "queue") return reply(await promptMigrationQueue());
    if (action === "stories-queue") return reply(await promptMigrationQueue(true));
    throw new ClientInputError("Неизвестная операция");
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  if (!supportAdminAuthorized(request)) return reply({ error: "Нет доступа" }, 401);
  if (!supportAdminOriginAllowed(request)) return reply({ error: "Откройте панель на основном адресе сайта" }, 403);
  try {
    const text = await request.text();
    if (text.length > 65536) return reply({ error: "Запрос слишком большой" }, 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(text); } catch { throw new ClientInputError("Некорректный запрос"); }
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirmed !== true) throw new ClientInputError("Подтвердите операцию");
    if (body.action === "review") {
      if (typeof body.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.fingerprint)) throw new ClientInputError("Откройте карточку заново");
      return reply(await reviewPromptMigration(id(body.characterId), body.fingerprint, body.fields));
    }
    if (body.action === "finalize") {
      if (body.qualityConfirmed !== true) throw new ClientInputError("Сначала подтвердите приёмку новой сборки");
      return reply(await finalizePromptRollout());
    }
    if (body.action !== "apply" && body.action !== "rollback" && body.action !== "stories") throw new ClientInputError("Неизвестная операция");
    if (body.backupConfirmed !== true) throw new ClientInputError("Сначала подтвердите наличие свежего бэкапа");
    if (!Array.isArray(body.entryIds) || body.entryIds.length < 1 || body.entryIds.length > PROMPT_MIGRATION_BATCH_LIMIT) throw new ClientInputError("В пакете может быть от одной до пяти карточек");
    const ids = [...new Set(body.entryIds.map(id))];
    const fingerprints: Record<string, string> = {};
    if (body.action === "stories" && body.fingerprints !== undefined) {
      if (!body.fingerprints || typeof body.fingerprints !== "object" || Array.isArray(body.fingerprints) || body.storyReviewConfirmed !== true) throw new ClientInputError("Подтвердите проверку актуальных полей карточки");
      for (const entryId of ids) {
        const fingerprint = (body.fingerprints as Record<string, unknown>)[entryId];
        if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new ClientInputError("Откройте карточку заново");
        fingerprints[entryId] = fingerprint;
      }
    }
    const results = [];
    for (const entryId of ids) {
      try { results.push(await (body.action === "apply" ? applyPromptMigration(entryId) : body.action === "stories" ? alignPromptMigrationStories(entryId, fingerprints[entryId]) : rollbackPromptMigration(entryId))); }
      catch (error) {
        if (error instanceof PromptMigrationConflict || error instanceof ClientInputError || error instanceof PromptBudgetError) {
          results.push({ entryId, status: "blocked", error: error.message });
        } else {
          errorLog("PromptMigration", "batch item failed", toSafeDiagnostic(error), { id: entryId });
          results.push({ entryId, status: "failed", error: "Операция не выполнена. Проверьте серверные логи." });
        }
        // Keep completed items visible and stop before touching the next card.
        break;
      }
    }
    return reply({ results });
  } catch (error) { return failure(error); }
}
