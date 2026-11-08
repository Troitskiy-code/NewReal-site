import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { reserveAvatarGeneration, getAvatarTokenStatus, getAvatarUsageUser, AvatarRequestConflict } from "@/lib/avatarTokens";
import { buildAvatarPrompt } from "@/lib/avatarPrompt";
import { readAvatarCardSnapshot, writeAvatarPrompt } from "@/lib/avatarPromptWriter";
import { isSafeAvatarReference } from "@/lib/avatarReference";
import { KieError, hasKieKey, prepareKieReference, uploadKieReference } from "@/lib/kieAi";
import { kieAvatarModel, KIE_CREDIT_RUB } from "@/lib/kieAvatarModels";
import { createAvatarTaskWithRewrites, publicAvatarJob, finishAvatarJob, reconcileAvatarJob, safetyRewriteCode } from "@/lib/kieAvatarJobs";
import { withAiCostContext, setAiCostActor, recordKieAvatarCost } from "@/lib/aiCostTelemetry";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { readAvatarBody, AvatarBodyTooLarge } from "@/lib/avatarRequest";
import { chatThreadsEnabled } from "@/lib/chatThreads";
import { getAuthorizedCharacterForChat } from "@/lib/chatAccess";
import { isSameOriginRequest } from "@/lib/telegram/http";
import { STORY_SCENE_SCOPE_PREFIX, storySceneThreadId } from "@/lib/storySceneShared";
import { buildStorySceneSnapshot, mayShowStorySceneUnderwear, STORY_SCENE_MESSAGE_LIMIT, StoryScenePromptUnavailable, writeStoryScenePrompt } from "@/lib/storyScenePrompt";
import { readCharacterAvatarReference } from "@/lib/characterMedia";
import { cropReferenceFace, withFaceReferenceSentence } from "@/lib/referenceFaceCrop";

export const runtime = "nodejs";
export const maxDuration = 60;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const validScope = (value: string) => /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const validKey = (value: string) => /^[a-zA-Z0-9_-]{16,128}$/.test(value);

export async function POST(req: NextRequest) {
  return withAiCostContext(async () => {
    let job: Awaited<ReturnType<typeof prisma.avatarGeneration.findUnique>> = null;
    let attempted = false;
    let ownsNewJob = false;
    // Which step failed; logged with our own error code because provider text is never logged.
    let stage = "request";
    let withReference = false;
    try {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id) return json({ error: "Не авторизован" }, 401);
      if (!hasKieKey()) return json({ error: "Сервис генерации временно недоступен" }, 503);
      const raw = await readAvatarBody(req, 7_100_000);
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw); } catch { return json({ error: "Некорректный запрос" }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Некорректный запрос" }, 400);
      const name = text(body.name), reference = text(body.referenceImage), scope = text(body.scope), clientKey = text(body.clientKey);
      if (!validScope(scope) || !validKey(clientKey)) return json({ error: "Некорректный идентификатор генерации. Обновите страницу." }, 400);
      const storyThreadId = storySceneThreadId(scope);
      let scene: ReturnType<typeof buildStorySceneSnapshot> | undefined;
      let storyReference: Buffer | null = null;
      let allowUnderwear = false;
      if (scope.startsWith(STORY_SCENE_SCOPE_PREFIX)) {
        if (!storyThreadId || reference) return json({ error: "Некорректный запрос иллюстрации" }, 400);
        if (!isSameOriginRequest(req)) return json({ error: "Доступ запрещён" }, 403);
        const thread = chatThreadsEnabled() ? await prisma.chatThread.findFirst({ where: { id: storyThreadId, userId: session.user.id },
          select: { characterId: true, character: { select: { name: true, appearance: true, description: true, artStyle: true, roleplayMode: true,
            rpConfig: true, imageUrl: true, userId: true } } } }) : null;
        if (!thread) return json({ error: "История не найдена" }, 404);
        const access = await getAuthorizedCharacterForChat(session.user.id, thread.characterId);
        if ("error" in access) return json({ error: access.error }, access.status);
        const existing = await prisma.avatarGeneration.findUnique({ where: { userId_clientKey: { userId: session.user.id, clientKey } } });
        if (existing) {
          if (existing.scope !== scope) throw new AvatarRequestConflict("Story scene idempotency conflict");
          const updated = await reconcileAvatarJob(existing.id) ?? existing;
          const usage = await getAvatarUsageUser(session.user.id);
          return json({ ...publicAvatarJob(updated), tokenStatus: getAvatarTokenStatus(usage) }, updated.state === "succeeded" ? 200 : 202);
        }
        const messages = await prisma.message.findMany({ where: { threadId: storyThreadId, userId: session.user.id,
          characterId: thread.characterId, role: { in: ["user", "assistant"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: STORY_SCENE_MESSAGE_LIMIT, select: { id: true, role: true, content: true } });
        scene = buildStorySceneSnapshot(messages.reverse(), thread.character);
        if (!scene.turns.length) return json({ error: "В истории пока нет сцены для иллюстрации" }, 400);
        if (scene.card.type !== "world") {
          stage = "read_character_avatar";
          storyReference = await readCharacterAvatarReference(thread.character.imageUrl, thread.character.userId ?? "");
        }
        const { name: cardName, appearance, description, rpConfig } = thread.character;
        allowUnderwear = await mayShowStorySceneUnderwear({ id: thread.characterId, userId: thread.character.userId, imageUrl: thread.character.imageUrl }, Boolean(storyReference),
          JSON.stringify([cardName, appearance, description, rpConfig]), scene.turns.map(turn => turn.text).join("\n"));
      } else if (!name || name.length > 200) return json({ error: "Укажите имя или название до 200 символов" }, 400);
      withReference = Boolean(reference || storyReference);
      if (reference && !isSafeAvatarReference(reference)) {
        // Only the declared type and size, never the image: tells a format problem from a size one.
        const mime = /^data:([a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60})?[;,]/i.exec(reference);
        infoLog("KieAvatar", "Reference rejected", { declared: mime ? mime[1] ?? "none" : "not_data_url", length: reference.length });
        return json({ error: "Загрузите PNG, JPEG, WebP или GIF размером до 5 МБ" }, 400);
      }
      stage = "prepare_reference";
      const prepared = withReference ? await prepareKieReference(storyReference ?? reference) : undefined;
      stage = "reserve";
      const templatePrompt = scene ? "" : buildAvatarPrompt(body);
      // Never accept modelId, resolution or number of images from the client.
      const model = kieAvatarModel(withReference);
      // Hash the card fields, not the written prompt: the writer model varies, and a retried request
      // with the same key must still match its original. A scene has no editable fields, so retries match
      // even when the chat has advanced.
      const payloadHash = createHash("sha256").update(JSON.stringify(scene ? [scope]
        : [scope, templatePrompt, readAvatarCardSnapshot(body), reference])).digest("hex");
      const reservation = await reserveAvatarGeneration(session.user.id, {
        clientKey, scope, payloadHash, model: model.id, estimatedCredits: model.estimatedCredits, creditRub: KIE_CREDIT_RUB,
      });
      if (!reservation) return json({ error: "Достигнут месячный лимит генераций" }, 402);
      job = reservation.generation;
      setAiCostActor(session.user.id, reservation.user.subscriptionType);
      if (job.scope !== scope) return json({ error: "Другая генерация ещё выполняется. Дождитесь её завершения." }, 409);
      if (reservation.isNew) {
        ownsNewJob = true;
        await recordKieAvatarCost(job);
        // Only a new job reaches the writer, so a retried request never pays for a second prompt.
        stage = "write_prompt";
        const written = scene ? { prompt: await writeStoryScenePrompt(scene, withReference, allowUnderwear), source: "llm" as const, reason: undefined }
          : await writeAvatarPrompt(body, templatePrompt);
        infoLog("KieAvatar", "Prompt prepared", { jobId: job.id, source: written.source, ...(written.reason ? { reason: written.reason } : {}) });
        stage = "crop_face";
        const faceCrop = prepared ? await cropReferenceFace(prepared) : null;
        infoLog("KieAvatar", "Face close-up", { jobId: job.id, added: Boolean(faceCrop) });
        stage = "upload_reference";
        const referenceUrls = prepared ? [await uploadKieReference(prepared)] : [];
        if (faceCrop) referenceUrls.push(await uploadKieReference(faceCrop));
        const prompt = faceCrop ? withFaceReferenceSentence(written.prompt) : written.prompt;
        stage = "create_task";
        attempted = true;
        const { taskId, rewrites } = await createAvatarTaskWithRewrites(prompt, referenceUrls, 0, Boolean(scene));
        // No prompt/reference/key: operators can recover a task after a DB write failure.
        infoLog("KieAvatar", "Task accepted", { taskId, jobId: job.id, model: model.id });
        stage = "save_task";
        job = await prisma.avatarGeneration.update({ where: { id: job.id }, data: {
          providerTaskId: taskId, state: "pending", errorCode: safetyRewriteCode(rewrites), leaseUntil: null, nextPollAt: new Date(),
        } });
        await recordKieAvatarCost(job);
      } else {
        job = await reconcileAvatarJob(job.id) ?? job;
      }
      const usage = await getAvatarUsageUser(session.user.id);
      return json({ ...publicAvatarJob(job), tokenStatus: getAvatarTokenStatus(usage) }, job.state === "succeeded" ? 200 : 202);
    } catch (error) {
      errorLog("KieAvatar", "Unable to start generation", {
        stage,
        withReference,
        ...(error instanceof KieError ? { kieCode: error.code, rejected: error.rejected, ...(error.httpStatus ? { status: error.httpStatus } : {}) } : {}),
        ...toSafeDiagnostic(error),
      });
      if (error instanceof AvatarBodyTooLarge) return json({ error: "Референс слишком большой" }, 413);
      if (error instanceof AvatarRequestConflict) return json({ error: "Запрос изменился. Проверьте результат предыдущей генерации перед новым запуском." }, 409);
      if (job && ownsNewJob) {
        // A post-acceptance DB/status failure must not stop reconciliation of a known task.
        if (!job.providerTaskId) {
          job = await finishAvatarJob(job, !attempted || (error instanceof KieError && error.rejected) ? "failed" : "uncertain",
            { errorCode: error instanceof KieError ? error.code : error instanceof StoryScenePromptUnavailable ? "no_scene" : "internal" }).catch(() => null);
        }
        if (job) {
          const usage = await getAvatarUsageUser(job.userId).catch(() => null);
          return json({ ...publicAvatarJob(job), ...(usage ? { tokenStatus: getAvatarTokenStatus(usage) } : {}) }, 202);
        }
      }
      return json({ error: error instanceof KieError && error.code === "invalid_reference"
        ? "Не удалось прочитать референс. Загрузите другое изображение PNG, JPEG или WebP."
        : "Не удалось запустить генерацию. Попробуйте проверить её статус позже." }, error instanceof KieError && error.code === "invalid_reference" ? 400 : 503);
    }
  });
}

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return json({ error: "Не авторизован" }, 401);
    const jobId = req.nextUrl.searchParams.get("jobId");
    const scope = req.nextUrl.searchParams.get("scope") ?? "";
    if ((jobId && !validKey(jobId)) || (!jobId && !validScope(scope))) return json({ error: "Некорректный идентификатор" }, 400);
    const job = jobId
      ? await prisma.avatarGeneration.findFirst({ where: { id: jobId, userId: session.user.id } })
      : await prisma.avatarGeneration.findFirst({ where: { userId: session.user.id, scope }, orderBy: { createdAt: "desc" } });
    if (jobId && !job) return json({ error: "Генерация не найдена" }, 404);
    const updated = job ? await reconcileAvatarJob(job.id) : null;
    const user = await getAvatarUsageUser(session.user.id);
    return json({ ...(updated ? publicAvatarJob(updated) : { state: "none" }), tokenStatus: user ? getAvatarTokenStatus(user) : undefined });
  } catch (error) {
    errorLog("KieAvatar", "Unable to read generation", toSafeDiagnostic(error));
    return json({ error: "Не удалось проверить генерацию" }, 503);
  }
}
