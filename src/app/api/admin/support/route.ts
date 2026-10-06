import { prisma } from '@/lib/prisma';
import { supportAdminAuthorized } from '@/lib/supportAdmin';
import { enqueueSupportReply } from '@/lib/supportReplies';
import { errorLog, toSafeDiagnostic } from '@/lib/logger';
import { isSupportReplySchemaMissing, SUPPORT_SCHEMA_MESSAGE } from '@/lib/supportSchema';

export const runtime = 'nodejs';
const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request) {
  if (!supportAdminAuthorized(request)) return respond({ error: 'Нет доступа' }, 401);
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('ticketId');
    if (id) {
      // A missing replies migration must not hide the original customer message.
      const ticket = await prisma.supportTicket.findUnique({ where: { id }, select: {
        id: true, email: true, topic: true, status: true, createdAt: true, message: true,
      } });
      if (!ticket) return respond({ error: 'Тикет не найден' }, 404);
      try {
        const replies = await prisma.supportReply.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' },
          select: { id: true, message: true, status: true, createdAt: true } });
        return respond({ ticket: { ...ticket, replies }, replyAvailability: { ready: true } });
      } catch (error) {
        errorLog('Support:Admin', 'reply history unavailable', toSafeDiagnostic(error), { ticketId: id });
        const missingSchema = isSupportReplySchemaMissing(error);
        return respond({ ticket: { ...ticket, replies: [] }, replyAvailability: { ready: false,
          code: missingSchema ? 'SUPPORT_SCHEMA_NOT_READY' : 'SUPPORT_HISTORY_UNAVAILABLE',
          message: missingSchema ? SUPPORT_SCHEMA_MESSAGE : 'Не удалось загрузить историю ответов. Обновите статус или повторите позже.',
        } });
      }
    }
    const cursor = url.searchParams.get('cursor');
    const tickets = await prisma.supportTicket.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, email: true, topic: true, status: true, createdAt: true } });
    return respond({ tickets: tickets.slice(0, 20), cursor: tickets.length > 20 ? tickets[19].id : null });
  } catch (error) {
    errorLog('Support:Admin', 'ticket read failed', toSafeDiagnostic(error));
    return respond({ error: 'Не удалось загрузить обращения' }, 500);
  }
}

export async function POST(request: Request) {
  if (!supportAdminAuthorized(request)) return respond({ error: 'Нет доступа' }, 401);
  // Bearer authentication is required; reject cross-site browser writes as well.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return respond({ error: 'Недопустимый источник' }, 403);
  try {
    const text = await request.text();
    if (text.length > 25000) return respond({ error: 'Слишком длинный ответ' }, 413);
    const body = JSON.parse(text);
    if (typeof body.ticketId !== 'string' || body.ticketId.length > 128 ||
        typeof body.clientKey !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(body.clientKey) ||
        typeof body.message !== 'string' || !body.message.trim() || body.message.trim().length > 10000)
      return respond({ error: 'Проверьте текст и номер обращения' }, 400);
    const ticket = await prisma.supportTicket.findUnique({ where: { id: body.ticketId }, select: { id: true } });
    if (!ticket) return respond({ error: 'Тикет не найден' }, 404);
    try {
      const reply = await enqueueSupportReply(body.ticketId, body.clientKey, body.message.trim());
      return reply ? respond({ reply }, 202) : respond({ error: 'Ключ уже использован для другого ответа' }, 409);
    } catch (error) {
      if (!isSupportReplySchemaMissing(error)) throw error;
      errorLog('Support:Admin', 'reply schema unavailable', toSafeDiagnostic(error));
      return respond({ error: SUPPORT_SCHEMA_MESSAGE, code: 'SUPPORT_SCHEMA_NOT_READY' }, 503);
    }
  } catch (error) {
    errorLog('Support:Admin', 'reply save failed', toSafeDiagnostic(error));
    return respond({ error: 'Не удалось сохранить ответ' }, 500);
  }
}
