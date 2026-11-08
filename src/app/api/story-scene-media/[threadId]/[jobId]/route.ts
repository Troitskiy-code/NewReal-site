import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValidThreadId, toThreadSummary } from "@/lib/chatThreads";
import { deleteStorySceneImages, readStorySceneImage, readStorySceneThumb } from "@/lib/characterMedia";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { isSameOriginRequest } from "@/lib/telegram/http";
import { isStorySceneJobId, storySceneImagePath, storySceneScope } from "@/lib/storySceneShared";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex" };
type RouteContext = { params: Promise<{ threadId: string; jobId: string }> };

/** The viewer's own finished, not deleted illustration in their own story; anything else is the same 404. */
async function ownedScene(context: RouteContext) {
  const { threadId, jobId } = await context.params;
  if (!isValidThreadId(threadId) || !isStorySceneJobId(jobId)) return null;
  const userId = (await getServerSession(authOptions))?.user?.id;
  if (!userId) return null;
  const thread = await prisma.chatThread.findFirst({ where: { id: threadId, userId } });
  if (!thread) return null;
  const job = await prisma.avatarGeneration.findFirst({ where: { id: jobId, userId, scope: storySceneScope(threadId),
    state: "succeeded", imageUrl: storySceneImagePath(threadId, jobId) }, select: { id: true } });
  return job ? { userId, thread, jobId } : null;
}

export async function GET(req: Request, context: RouteContext) {
  try {
    const scene = await ownedScene(context);
    if (!scene) return new Response(null, { status: 404, headers });
    const thumb = new URL(req.url).searchParams.get("size") === "thumb";
    const image = thumb ? await readStorySceneThumb(scene.userId, scene.thread.id, scene.jobId)
      : await readStorySceneImage(scene.userId, scene.thread.id, scene.jobId);
    return new Response(image, { headers: { ...headers, "Content-Type": "image/webp", "Content-Length": String(image.byteLength) } });
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404 ? 404 : 503;
    return new Response(null, { status, headers });
  }
}

/** Removes an illustration from the gallery. The paid job row stays for accounting without its image. */
export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    if (!isSameOriginRequest(req)) return NextResponse.json({ error: "Доступ запрещён" }, { status: 403, headers });
    const scene = await ownedScene(context);
    if (!scene) return NextResponse.json({ error: "Иллюстрация не найдена" }, { status: 404, headers });
    const thread = await prisma.$transaction(async tx => {
      await tx.avatarGeneration.update({ where: { id: scene.jobId }, data: { imageUrl: null } });
      // The story falls back to the character avatar when its current illustration is deleted.
      return tx.chatThread.update({ where: { id: scene.thread.id },
        data: scene.thread.sceneAvatarJobId === scene.jobId ? { sceneAvatarJobId: null } : {} });
    });
    await deleteStorySceneImages(scene.userId, scene.thread.id, [scene.jobId])
      .catch(error => errorLog("Server", "[StoryScene] image not deleted", toSafeDiagnostic(error)));
    return NextResponse.json({ thread: toThreadSummary(thread) }, { headers });
  } catch (error) {
    errorLog("Server", "[StoryScene] delete failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось удалить иллюстрацию" }, { status: 500, headers });
  }
}
