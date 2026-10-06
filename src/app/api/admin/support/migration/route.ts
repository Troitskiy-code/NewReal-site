import { supportAdminAuthorized, supportAdminOriginAllowed } from '@/lib/supportAdmin';
import { SUPPORT_REPLY_MIGRATION } from '@/lib/supportSchema';
import { applySupportMigration, inspectSupportMigration, SupportMigrationBlocked, SupportMigrationBusy } from '@/lib/supportMigration';
import { errorLog, toSafeDiagnostic } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 30;
const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request) {
  if (!supportAdminAuthorized(request)) return respond({ error: 'Нет доступа' }, 401);
  try { return respond(await inspectSupportMigration()); }
  catch (error) {
    errorLog('Support:Migration', 'inspection failed', toSafeDiagnostic(error));
    return respond({ error: 'Не удалось проверить схему базы. Проверьте доступ приложения к базе и серверные логи.' }, 503);
  }
}

export async function POST(request: Request) {
  if (!supportAdminAuthorized(request)) return respond({ error: 'Нет доступа' }, 401);
  if (!supportAdminOriginAllowed(request)) {
    errorLog('Support:Migration', 'request origin rejected', { reason: 'untrusted_origin' });
    return respond({ error: 'Адрес страницы не разрешён для этой операции. Откройте панель через https://newvers.ai.', code: 'SUPPORT_ORIGIN_DENIED' }, 403);
  }
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 512) return respond({ error: 'Недопустимый запрос' }, 413);
    body = JSON.parse(text);
  } catch { return respond({ error: 'Недопустимый запрос' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 ||
    (body as Record<string, unknown>).action !== 'apply' || (body as Record<string, unknown>).migration !== SUPPORT_REPLY_MIGRATION)
    return respond({ error: 'Разрешена только миграция ответов поддержки' }, 400);
  try { return respond(await applySupportMigration()); }
  catch (error) {
    if (error instanceof SupportMigrationBlocked) return respond({ error: error.message, status: error.status }, 409);
    if (error instanceof SupportMigrationBusy) return respond({ error: error.message }, 409);
    errorLog('Support:Migration', 'application failed', toSafeDiagnostic(error));
    return respond({ error: 'Миграция не применена. Проверьте права подключения БД и серверные логи. Изменения этой попытки отменены.' }, 503);
  }
}
