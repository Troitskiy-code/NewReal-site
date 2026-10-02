import { prisma } from "@/lib/prisma";
import { isAnonymousExpired } from "@/lib/anonymousCookie";
import { mapGuestMessagesToUserMessages } from "@/lib/anonymousChatMap";
import { assertGuestSchemaReady, GuestSchemaMissingError, lockGuestSession, recoverExpiredGuestGenerations } from "@/lib/guestRequestStore";
import { isLeaseActive } from "@/lib/guestRequestPolicy";

export type TransferResult =
  | { ok: true; alreadyTransferred: boolean; copied: number; characterIds: string[] }
  | { ok: false; code: "expired" | "foreign_session" | "not_found" | "in_progress" | "schema" };

export async function transferAnonymousChatToUser(params: {
  sessionId: string;
  userId: string;
}): Promise<TransferResult> {
  try {
    await assertGuestSchemaReady();
  } catch (error) {
    if (error instanceof GuestSchemaMissingError) return { ok: false, code: "schema" };
    throw error;
  }

  return prisma.$transaction(
    async (tx) => {
      if (!(await lockGuestSession(tx, params.sessionId))) return { ok: false, code: "not_found" as const };
      const session = await tx.anonymousSession.findUnique({
        where: { sessionId: params.sessionId },
      });
      if (!session) return { ok: false, code: "not_found" as const };
      if (isAnonymousExpired(session.expiresAt, session.createdAt)) {
        return { ok: false, code: "expired" as const };
      }
      if (session.transferredToUserId && session.transferredToUserId !== params.userId) {
        return { ok: false, code: "foreign_session" as const };
      }

      const now = new Date();
      const livePending = await tx.anonymousChatRequest.findMany({
        where: { sessionId: params.sessionId, status: "pending" },
      });
      if (livePending.some((row) => isLeaseActive(row.leaseUntil, now))) {
        return { ok: false, code: "in_progress" as const };
      }

      await recoverExpiredGuestGenerations(tx, params.sessionId, now);

      if (session.transferredToUserId === params.userId) {
        const existing = await tx.anonymousMessage.findMany({
          where: { sessionId: params.sessionId, transferredAt: { not: null } },
          select: { characterId: true },
          distinct: ["characterId"],
        });
        return {
          ok: true,
          alreadyTransferred: true,
          copied: 0,
          characterIds: existing.map((row) => row.characterId),
        };
      }

      const claimed = await tx.anonymousSession.updateMany({
        where: { sessionId: params.sessionId, transferredToUserId: null },
        data: { transferredToUserId: params.userId, transferredAt: now },
      });
      if (claimed.count === 0) {
        const again = await tx.anonymousSession.findUnique({
          where: { sessionId: params.sessionId },
          select: { transferredToUserId: true },
        });
        if (again?.transferredToUserId === params.userId) {
          return { ok: true, alreadyTransferred: true, copied: 0, characterIds: [] };
        }
        return { ok: false, code: "foreign_session" as const };
      }

      const completedIds = (
        await tx.anonymousChatRequest.findMany({
          where: { sessionId: params.sessionId, status: "completed" },
          select: { requestId: true },
        })
      ).map((row) => row.requestId);

      const guestMessages = await tx.anonymousMessage.findMany({
        where: {
          sessionId: params.sessionId,
          transferredAt: null,
          requestId: { in: completedIds.length ? completedIds : ["__none__"] },
        },
        orderBy: { createdAt: "asc" },
      });

      const already = await tx.message.findMany({
        where: { userId: params.userId, characterId: { in: [...new Set(guestMessages.map((m) => m.characterId))] } },
        select: { characterId: true, role: true, content: true, createdAt: true },
      });
      const seen = new Set(already.map((row) => `${row.characterId}:${row.role}:${row.content}:${row.createdAt.toISOString()}`));
      const uniqueGuest = guestMessages.filter(
        (message) => !seen.has(`${message.characterId}:${message.role}:${message.content}:${message.createdAt.toISOString()}`)
      );

      const copies = mapGuestMessagesToUserMessages(uniqueGuest, params.userId);
      if (copies.length > 0) {
        await tx.message.createMany({ data: copies });
        await tx.anonymousMessage.updateMany({
          where: { id: { in: uniqueGuest.map((item) => item.id) } },
          data: { transferredAt: now },
        });
        const counts = new Map<string, number>();
        for (const copy of copies) {
          counts.set(copy.characterId, (counts.get(copy.characterId) ?? 0) + 1);
        }
        for (const [characterId, count] of counts) {
          await tx.character.update({
            where: { id: characterId },
            data: { totalMessages: { increment: count }, lastActive: now },
          });
        }
      }

      return {
        ok: true,
        alreadyTransferred: false,
        copied: copies.length,
        characterIds: [...new Set(copies.map((item) => item.characterId))],
      };
    },
    { isolationLevel: "ReadCommitted" }
  ) as Promise<TransferResult>;
}
