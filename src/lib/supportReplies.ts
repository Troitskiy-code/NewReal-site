import { createHash, randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import { prisma } from '@/lib/prisma';
import { errorLog } from '@/lib/logger';

const WINDOW = 23 * 60 * 60 * 1000;
export function supportSender() {
  const sender = process.env['SUPPORT_FROM_EMAIL']?.trim() || 'NewVerse Support <support@newvers.ai>';
  if (!/^(?:[a-zA-Z0-9._+-]+@newvers\.ai|[^<>\r\n]+ <[a-zA-Z0-9._+-]+@newvers\.ai>)$/.test(sender)) throw new Error('Invalid SUPPORT_FROM_EMAIL');
  return sender;
}

export async function enqueueSupportReply(ticketId: string, clientKey: string, message: string) {
  const payloadHash = createHash('sha256').update(JSON.stringify([ticketId, message])).digest('hex');
  const existing = await prisma.supportReply.findUnique({ where: { clientKey } });
  if (existing) return existing.payloadHash === payloadHash ? existing : null;
  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new Error('Ticket not found');
  try {
    return await prisma.supportReply.create({ data: { ticketId, clientKey, payloadHash,
      recipient: ticket.email, sender: supportSender(), message, nextAttemptAt: new Date() } });
  } catch (error) {
    const raced = await prisma.supportReply.findUnique({ where: { clientKey } });
    if (raced) return raced.payloadHash === payloadHash ? raced : null;
    throw error;
  }
}

export type ReplyMail = { from: string; to: string; subject: string; text: string };
const deliveryErrors = {
  not_configured: 'Ответ сохранён, но RESEND_API_KEY не задан на сервере. Проверьте переменные проекта в Relaxdev.',
  access_denied: 'Ответ сохранён, но Resend отклонил доступ. Проверьте API-ключ и его права на отправку с домена newvers.ai.',
  invalid_sender: 'Ответ сохранён, но Resend отклонил отправителя или параметры письма. Проверьте подтверждение домена newvers.ai и SUPPORT_FROM_EMAIL.',
  quota_exceeded: 'Ответ сохранён, но достигнут лимит Resend. Проверьте лимиты в кабинете почтового сервиса.',
  timeout: 'Ответ сохранён, но Resend не подтвердил отправку за 10 секунд. Повторная попытка использует тот же ключ письма.',
  unavailable: 'Ответ сохранён, но отправка не подтверждена. Проверьте доступность Resend и журнал сервера; очередь повторит попытку.',
} as const;
type DeliveryErrorCode = keyof typeof deliveryErrors;
class ReplyDeliveryError extends Error {
  constructor(readonly code: DeliveryErrorCode) { super(code); }
}
function providerErrorCode(name: string): DeliveryErrorCode {
  if (['missing_api_key', 'invalid_api_key', 'restricted_api_key', 'invalid_access', 'security_error'].includes(name)) return 'access_denied';
  if (['validation_error', 'invalid_from_address', 'invalid_parameter', 'missing_required_field'].includes(name)) return 'invalid_sender';
  if (['monthly_quota_exceeded', 'daily_quota_exceeded', 'rate_limit_exceeded'].includes(name)) return 'quota_exceeded';
  return 'unavailable';
}
export async function sendReplyMail(mail: ReplyMail, key: string): Promise<string> {
  const apiKey = process.env['RESEND_API_KEY'];
  if (!apiKey?.trim()) throw new ReplyDeliveryError('not_configured');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      new Resend(apiKey).emails.send(mail, { idempotencyKey: key }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ReplyDeliveryError('timeout')), 10000); }),
    ]);
    if (result.error) throw new ReplyDeliveryError(providerErrorCode(result.error.name));
    if (!result.data?.id) throw new ReplyDeliveryError('unavailable');
    return result.data.id;
  } finally { if (timer) clearTimeout(timer); }
}

export async function processSupportReplies(limit = 1, send = sendReplyMail, replyId?: string) {
  const now = new Date();
  const scope = replyId ? { id: replyId } : {};
  await prisma.supportReply.updateMany({ where: { ...scope, status: 'sending', claimedAt: { lt: new Date(now.getTime() - 120000) } },
    data: { status: 'failed', claimToken: null, claimedAt: null, nextAttemptAt: now } });
  await prisma.supportReply.updateMany({ where: { ...scope, status: { in: ['pending', 'failed'] },
    OR: [{ attempts: { gte: 6 } }, { createdAt: { lt: new Date(now.getTime() - WINDOW) } }] },
    data: { status: 'dead', nextAttemptAt: null } });
  const rows = await prisma.supportReply.findMany({ where: { ...scope, status: { in: ['pending', 'failed'] },
    attempts: { lt: 6 }, createdAt: { gte: new Date(now.getTime() - WINDOW) },
    OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, orderBy: { createdAt: 'asc' }, take: limit });
  let accepted = 0;
  let errorCode: DeliveryErrorCode | undefined;
  for (const row of rows) {
    const claimToken = randomUUID();
    const claim = await prisma.supportReply.updateMany({ where: { id: row.id, status: { in: ['pending', 'failed'] }, attempts: row.attempts },
      data: { status: 'sending', claimToken, claimedAt: now, attempts: { increment: 1 } } });
    if (!claim.count) continue;
    try {
      const providerId = await send({ from: row.sender, to: row.recipient,
        subject: `NewVerse — ответ на обращение ${row.ticketId}`,
        text: `${row.message}\n\nОбращение: ${row.ticketId}\nЧтобы продолжить обращение, напишите через https://newvers.ai/ru/support и укажите этот номер.\nНе отвечайте на это письмо: входящий почтовый ящик пока не подключён.` }, `support-reply/${row.id}`);
      await prisma.$transaction(async tx => {
        const updated = await tx.supportReply.updateMany({ where: { id: row.id, status: 'sending', claimToken },
          data: { status: 'accepted', providerId, acceptedAt: new Date(), claimToken: null, claimedAt: null, nextAttemptAt: null } });
        if (updated.count) { await tx.supportTicket.update({ where: { id: row.ticketId }, data: { status: 'answered' } }); accepted++; }
      });
    } catch (error) {
      // Never return or log provider messages: they can contain addresses or keys.
      errorCode = error instanceof ReplyDeliveryError ? error.code : 'unavailable';
      errorLog('Support:Reply', 'delivery not confirmed', { reason: errorCode, ticketId: row.ticketId });
      const dead = row.attempts + 1 >= 6 || Date.now() - row.createdAt.getTime() >= WINDOW;
      await prisma.supportReply.updateMany({ where: { id: row.id, status: 'sending', claimToken },
        data: { status: dead ? 'dead' : 'failed', claimToken: null, claimedAt: null,
          nextAttemptAt: dead ? null : new Date(Date.now() + Math.min(1800000, 15000 * 2 ** (row.attempts + 1))) } });
    }
  }
  const needsReview = await prisma.supportReply.count({ where: { status: 'dead' } });
  return { accepted, requiresAttention: needsReview > 0, ...(errorCode ? { errorCode } : {}) };
}

export async function deliverSupportReply(replyId: string) {
  let errorCode: DeliveryErrorCode | undefined;
  try {
    ({ errorCode } = await processSupportReplies(1, sendReplyMail, replyId));
  } catch {
    // Saving the answer succeeded; a dispatch failure must not invite a new copy.
    errorCode = 'unavailable';
    errorLog('Support:Reply', 'dispatch unavailable', { reason: errorCode });
  }
  const reply = await prisma.supportReply.findUniqueOrThrow({ where: { id: replyId } });
  const message = reply.status === 'accepted' ? 'Ответ принят Resend. Доставку получателю можно проверить в кабинете Resend.'
    : errorCode ? deliveryErrors[errorCode]
    : reply.status === 'sending' ? 'Ответ уже отправляется. Обновите статус через несколько секунд.'
    : reply.status === 'dead' ? 'Лимит попыток или срок отправки исчерпан. Нужна проверка оператором; этот ответ автоматически не отправляется.'
    : reply.status === 'failed' ? 'Ответ сохранён. Повторная попытка будет доступна после указанного времени; cron также обработает очередь.'
    : 'Ответ сохранён в очереди. Обновите статус или запустите отправку сохранённого ответа.';
  return { reply, delivery: { message, ...(errorCode ? { code: errorCode } : {}) } };
}
