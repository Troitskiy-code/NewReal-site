import { Prisma } from '@prisma/client';

export const SUPPORT_REPLY_MIGRATION = '20261006120000_support_replies';
export const SUPPORT_SCHEMA_MESSAGE = `Отправка ответов пока недоступна. Нажмите «Проверить миграцию» в панели поддержки. Нужна миграция ${SUPPORT_REPLY_MIGRATION}.`;

// Called only around queries to SupportReply, never around unrelated database work.
export function isSupportReplySchemaMissing(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2021' || error.code === 'P2022');
}
