import { randomUUID } from "node:crypto";
import type { AvatarGeneration } from "@prisma/client";
import { prisma } from "./prisma";
import { createKieAvatar, getKieAvatarTask, KieError, saveKieImage, type KieRefusedInput } from "./kieAi";
import { recordKieAvatarCost, setAiCostActor, withAiCostContext } from "./aiCostTelemetry";
import { isAvatarSafetyRewriteEnabled, MAX_SAFETY_REWRITES, rewriteRefusedAvatarPrompt } from "./avatarPromptRewrite";
import { errorLog, infoLog, toSafeDiagnostic } from "./logger";
import { kieAvatarModel, uncertainBlockSecondsLeft, uncertainJobBlocks } from "./kieAvatarModels";
import { storySceneThreadId } from "./storySceneShared";
import { settleLockedAvatarReservation } from "./avatarTokens";

const STORY_SCENE_DELIVERY_WINDOW_MS = 30 * 60 * 1000;

/** While a job is pending, errorCode counts its rewrites: no prompt is kept and no column is needed. */
export function safetyRewriteCode(rewrites: number) {
  return rewrites > 0 ? `safety_rewrite_${rewrites}` : null;
}
function safetyRewritesUsed(job: AvatarGeneration) {
  return Number(/^safety_rewrite_(\d+)$/.exec(job.errorCode ?? "")?.[1] ?? 0);
}

/** A refused task costs nothing, so a moderation refusal at creation may be rewritten and sent again. */
export async function createAvatarTaskWithRewrites(prompt: string, referenceUrls: string[], used = 0, square = false) {
  let current = prompt, rewrites = used;
  for (;;) {
    try {
      return { taskId: await createKieAvatar(current, referenceUrls, square), rewrites };
    } catch (error) {
      if (!(error instanceof KieError && error.code === "safety") || !isAvatarSafetyRewriteEnabled() || rewrites >= MAX_SAFETY_REWRITES) throw error;
      const next = await rewriteRefusedAvatarPrompt(current, ++rewrites, referenceUrls.length > 0);
      if (!next) throw error;
      current = next;
    }
  }
}

export function publicAvatarJob(job: AvatarGeneration) {
  return { jobId: job.id, clientKey: job.clientKey, scope: job.scope, state: job.state,
    ...(job.state === "succeeded" ? { imageUrl: job.imageUrl } : {}),
    ...(job.state === "failed" ? { error: job.errorCode === "safety"
      ? "Запрос отклонён правилами генерации. Измените описание или референс."
      : job.errorCode === "no_scene" ? "Не удалось определить текущую сцену по сообщениям."
      : storySceneThreadId(job.scope) ? "Не удалось сгенерировать иллюстрацию."
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
    // A lost scene launch is still blocked against duplicate jobs, but the reader received no image.
    await settleLockedAvatarReservation(tx, job.reservationId,
      state === "uncertain" && !storySceneThreadId(job.scope) ? "review" : state === "succeeded");
    return updated;
  });
  if (result) await recordKieAvatarCost(result);
  return result;
}

/** Replaces a filter-refused task with a rewritten one. Null keeps the refusal, which refunds the generation. */
async function retryRefusedTask(job: AvatarGeneration, refused: KieRefusedInput | null, leaseToken: string) {
  const used = safetyRewritesUsed(job);
  if (!refused || !isAvatarSafetyRewriteEnabled() || used >= MAX_SAFETY_REWRITES) return null;
  const { prompt, referenceUrls } = refused;
  // A task from an earlier model has a different request shape; resending it would change the model.
  if (job.model !== kieAvatarModel(referenceUrls.length > 0).id) return null;
  const rewritten = await withAiCostContext(() => {
    setAiCostActor(job.userId);
    return rewriteRefusedAvatarPrompt(prompt, used + 1, referenceUrls.length > 0);
  });
  if (!rewritten) return null;
  let created: Awaited<ReturnType<typeof createAvatarTaskWithRewrites>>;
  try {
    created = await createAvatarTaskWithRewrites(rewritten, referenceUrls, used + 1, Boolean(storySceneThreadId(job.scope)));
  } catch (error) {
    if (error instanceof KieError && error.rejected) return null;
    // A lost createTask response may hide a billed task. Never automatically re-submit.
    return finishAvatarJob(job, "uncertain", { errorCode: "lost_create_response" }, leaseToken);
  }
  await prisma.avatarGeneration.updateMany({ where: { id: job.id, leaseToken, state: "pending" }, data: {
    providerTaskId: created.taskId, errorCode: safetyRewriteCode(created.rewrites), credits: null, nextPollAt: new Date(Date.now() + 3_000),
  } });
  // No prompt: only which attempt replaced which job.
  infoLog("KieAvatar", "Refused prompt rewritten", { jobId: job.id, taskId: created.taskId, rewrites: created.rewrites });
  return prisma.avatarGeneration.findUnique({ where: { id: job.id } });
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
  const storyThreadId = storySceneThreadId(job.scope);
  const deliveryExpired = Boolean(storyThreadId) && now.getTime() - job.createdAt.getTime() >= STORY_SCENE_DELIVERY_WINDOW_MS;
  let credits = job.credits;
  try {
    const result = await getKieAvatarTask(job.providerTaskId);
    if (result.model !== job.model) throw new Error("Image task model mismatch");
    credits = result.credits ?? credits;
    if (result.state === "fail") {
      const retried = await retryRefusedTask(job, result.refusedInput, leaseToken);
      if (retried) return retried;
      return await finishAvatarJob(job, "failed", { errorCode: result.errorCode ?? "provider_error", credits: result.credits }, leaseToken);
    }
    if (result.state === "success" && result.imageUrl) {
      // Persist WebP in our bucket before consuming success; provider links expire.
      const imageUrl = storyThreadId ? await saveKieImage(result.imageUrl, job.userId, job.id, storyThreadId)
        : await saveKieImage(result.imageUrl, job.userId, job.id);
      return await finishAvatarJob(job, "succeeded", { imageUrl, credits: result.credits }, leaseToken);
    }
    if (deliveryExpired) return await finishAvatarJob(job, "failed", { errorCode: "delivery_timeout", credits }, leaseToken);
    await prisma.avatarGeneration.updateMany({ where: { id, leaseToken, state: "pending" }, data: {
      credits: result.credits ?? job.credits, nextPollAt: new Date(Date.now() + 5_000),
    } });
  } catch (error) {
    // Poll/download failures do not mean generation failed. Keep the task and quota, but an undelivered
    // story image cannot hold a reservation indefinitely.
    errorLog("KieAvatar", "Unable to reconcile task", toSafeDiagnostic(error));
    if (deliveryExpired) return await finishAvatarJob(job, "failed", { errorCode: "delivery_timeout", credits }, leaseToken);
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
