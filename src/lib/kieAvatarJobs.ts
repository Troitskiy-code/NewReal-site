import { randomUUID } from "node:crypto";
import type { AvatarGeneration } from "@prisma/client";
import { prisma } from "./prisma";
import { getKieAvatarTask, saveKieImage } from "./kieAi";
import { recordKieAvatarCost } from "./aiCostTelemetry";
import { errorLog, toSafeDiagnostic } from "./logger";
import { uncertainBlockSecondsLeft, uncertainJobBlocks } from "./kieAvatarModels";

export function publicAvatarJob(job: AvatarGeneration) {
  return { jobId: job.id, clientKey: job.clientKey, scope: job.scope, state: job.state,
    ...(job.state === "succeeded" ? { imageUrl: job.imageUrl } : {}),
    ...(job.state === "failed" ? { error: job.errorCode === "safety"
      ? "Запрос отклонён правилами генерации. Измените описание или референс."
      : "Не удалось сгенерировать изображение. Генерация возвращена в лимит." } : {}),
    // The client keeps the button disabled while "blocked" and re-checks after retryAfterSeconds.
    ...(job.state === "uncertain" ? uncertainJobBlocks(job)
      ? { blocked: true, retryAfterSeconds: uncertainBlockSecondsLeft(job),
        error: `Сервис генерации не подтвердил запуск. Новую генерацию можно будет запустить через ${Math.max(1, Math.ceil(uncertainBlockSecondsLeft(job) / 60))} мин.` }
      : { blocked: false, error: "Предыдущий запуск не подтвердился. Можно запустить новую генерацию." } : {}),
  };
}

export async function finishAvatarJob(job: AvatarGeneration, state: "succeeded" | "failed" | "uncertain",
  values: { imageUrl?: string; credits?: number | null; errorCode?: string } = {}, leaseToken?: string) {
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${job.userId} FOR UPDATE`;
    const current = await tx.avatarGeneration.findUnique({ where: { id: job.id } });
    if (!current || current.state !== job.state || ["succeeded", "failed"].includes(current.state)
      || (leaseToken && current.leaseToken !== leaseToken)) return current;
    const updated = await tx.avatarGeneration.update({ where: { id: job.id }, data: {
      state, ...values, leaseToken: null, leaseUntil: null,
    } });
    const reservation = await tx.avatarQuotaReservation.findUnique({ where: { id: job.reservationId } });
    if (reservation?.status === "reserved" || reservation?.status === "manual_review") {
      await tx.avatarQuotaReservation.update({ where: { id: job.reservationId }, data: {
        status: state === "succeeded" ? "completed" : state === "failed" ? "refunded" : "manual_review",
      } });
      if (state === "failed") {
        // A subscription activation or month rollover may have reset usage already.
        await tx.user.updateMany({ where: { id: job.userId, lastTokenMonth: reservation.month,
          tokensUsedThisMonth: { gte: reservation.units } }, data: { tokensUsedThisMonth: { decrement: reservation.units } } });
      }
    }
    return updated;
  });
  if (result) await recordKieAvatarCost(result);
  return result;
}

export async function reconcileAvatarJob(id: string) {
  const job = await prisma.avatarGeneration.findUnique({ where: { id } });
  if (!job) return null;
  if (["succeeded", "failed", "uncertain"].includes(job.state)) {
    await recordKieAvatarCost(job); return job;
  }
  if (job.state === "creating") {
    if (job.leaseUntil && job.leaseUntil < new Date()) {
      // A lost createTask response may hide a billed task. Never automatically re-submit.
      return finishAvatarJob(job, "uncertain", { errorCode: "lost_create_response" });
    }
    return job;
  }
  if (!job.providerTaskId) return job;
  const now = new Date(), leaseToken = randomUUID();
  const claimed = await prisma.avatarGeneration.updateMany({ where: { id, state: "pending", nextPollAt: { lte: now },
    OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseToken, leaseUntil: new Date(Date.now() + 120_000) } });
  if (!claimed.count) return job;
  try {
    const result = await getKieAvatarTask(job.providerTaskId);
    if (result.model !== job.model) throw new Error("Image task model mismatch");
    if (result.state === "fail") return await finishAvatarJob(job, "failed", { errorCode: result.errorCode ?? "provider_error", credits: result.credits }, leaseToken);
    if (result.state === "success" && result.imageUrl) {
      // Persist WebP in our bucket before consuming success; provider links expire.
      const imageUrl = await saveKieImage(result.imageUrl, job.userId, job.id);
      return await finishAvatarJob(job, "succeeded", { imageUrl, credits: result.credits }, leaseToken);
    }
    await prisma.avatarGeneration.updateMany({ where: { id, leaseToken, state: "pending" }, data: {
      credits: result.credits ?? job.credits, nextPollAt: new Date(Date.now() + 5_000),
    } });
  } catch (error) {
    // Poll/download failures do not mean generation failed. Keep the task and quota.
    errorLog("KieAvatar", "Unable to reconcile task", toSafeDiagnostic(error));
    await prisma.avatarGeneration.updateMany({ where: { id, leaseToken, state: "pending" }, data: { nextPollAt: new Date(Date.now() + 30_000) } });
  } finally {
    await prisma.avatarGeneration.updateMany({ where: { id, leaseToken }, data: { leaseToken: null, leaseUntil: null } });
  }
  const updated = await prisma.avatarGeneration.findUnique({ where: { id } });
  if (updated) await recordKieAvatarCost(updated);
  return updated;
}

export async function reconcileAvatarBatch() {
  const jobs = await prisma.avatarGeneration.findMany({ where: { state: { in: ["creating", "pending"] }, nextPollAt: { lte: new Date() } },
    orderBy: { nextPollAt: "asc" }, take: 3 });
  const result = { checked: 0, succeeded: 0, failed: 0, pending: 0, requiresAttention: 0 };
  for (const job of jobs) {
    const updated = await reconcileAvatarJob(job.id); result.checked++;
    if (updated?.state === "succeeded") result.succeeded++;
    else if (updated?.state === "failed") result.failed++;
    else if (updated?.state === "uncertain") result.requiresAttention++;
    else result.pending++;
  }
  result.requiresAttention = await prisma.avatarGeneration.count({ where: { state: "uncertain" } });
  return result;
}
