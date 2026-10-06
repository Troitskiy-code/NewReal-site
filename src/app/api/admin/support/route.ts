import { prisma } from '@/lib/prisma';
import { supportAdminAuthorized } from '@/lib/supportAdmin';
import { enqueueSupportReply } from '@/lib/supportReplies';

export const runtime = 'nodejs';
const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request) {
  if (!supportAdminAuthorized(request)) return respond({ error: 'Нет доступа' }, 401);
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('ticketId');
    if (id) {
      const ticket = await prisma.supportTicket.findUnique({ where: { id }, include: { replies: { orderBy: { createdAt: 'asc' } } } });
      return ticket ? respond({ ticket }) : respond({ error: 'Тикет не найден' }, 404);
    }
    const cursor = url.searchParams.get('cursor');
    const tickets = await prisma.supportTicket.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, email: true, topic: true, status: true, createdAt: true } });
    return respond({ tickets: tickets.slice(0, 20), cursor: tickets.length > 20 ? tickets[19].id : null });
  } catch { return respond({ error: 'Не удалось загрузить обращения' }, 500); }
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
    const reply = await enqueueSupportReply(body.ticketId, body.clientKey, body.message.trim());
    return reply ? respond({ reply }, 202) : respond({ error: 'Ключ уже использован для другого ответа' }, 409);
  } catch { return respond({ error: 'Не удалось сохранить ответ' }, 500); }
}
