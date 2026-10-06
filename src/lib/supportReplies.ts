import { createHash, randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import { prisma } from '@/lib/prisma';

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
      recipient: ticket.email, sender: supportSender(), message } });
  } catch (error) {
    const raced = await prisma.supportReply.findUnique({ where: { clientKey } });
    if (raced) return raced.payloadHash === payloadHash ? raced : null;
    throw error;
  }
}

export type ReplyMail = { from: string; to: string; subject: string; text: string };
export async function sendReplyMail(mail: ReplyMail, key: string): Promise<string> {
  const apiKey = process.env['RESEND_API_KEY'];
  if (!apiKey) throw new Error('Email not configured');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      new Resend(apiKey).emails.send(mail, { idempotencyKey: key }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Delivery timeout')), 10000); }),
    ]);
    if (result.error || !result.data?.id) throw new Error('Delivery failed');
    return result.data.id;
  } finally { if (timer) clearTimeout(timer); }
}

export async function processSupportReplies(limit = 1, send = sendReplyMail) {
  const now = new Date();
  await prisma.supportReply.updateMany({ where: { status: 'sending', claimedAt: { lt: new Date(now.getTime() - 120000) } },
    data: { status: 'failed', claimToken: null, claimedAt: null, nextAttemptAt: now } });
  await prisma.supportReply.updateMany({ where: { status: { in: ['pending', 'failed'] },
    OR: [{ attempts: { gte: 6 } }, { createdAt: { lt: new Date(now.getTime() - WINDOW) } }] },
    data: { status: 'dead', nextAttemptAt: null } });
  const rows = await prisma.supportReply.findMany({ where: { status: { in: ['pending', 'failed'] },
    attempts: { lt: 6 }, createdAt: { gte: new Date(now.getTime() - WINDOW) },
    OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, orderBy: { createdAt: 'asc' }, take: limit });
  let accepted = 0;
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
    } catch {
      const dead = row.attempts + 1 >= 6 || Date.now() - row.createdAt.getTime() >= WINDOW;
      await prisma.supportReply.updateMany({ where: { id: row.id, status: 'sending', claimToken },
        data: { status: dead ? 'dead' : 'failed', claimToken: null, claimedAt: null,
          nextAttemptAt: dead ? null : new Date(Date.now() + Math.min(1800000, 15000 * 2 ** (row.attempts + 1))) } });
    }
  }
  const needsReview = await prisma.supportReply.count({ where: { status: 'dead' } });
  return { accepted, requiresAttention: needsReview > 0 };
}
