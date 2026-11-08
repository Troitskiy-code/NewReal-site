import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValidThreadId } from "@/lib/chatThreads";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { STORY_SCENE_GALLERY_LIMIT, storySceneImagePath, storySceneScope, storySceneThumbPath, type StorySceneItem } from "@/lib/storySceneShared";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

/** The story's gallery, newest first. Images live in private storage; the database holds only the job rows. */
export async function GET(_req: Request, context: { params: Promise<{ threadId: string }> }) {
  try {
    const { threadId } = await context.params;
    const userId = (await getServerSession(authOptions))?.user?.id;
    if (!userId || !isValidThreadId(threadId)) return NextResponse.json({ error: "История не найдена" }, { status: 404, headers });
    const thread = await prisma.chatThread.findFirst({ where: { id: threadId, userId }, select: { id: true } });
    if (!thread) return NextResponse.json({ error: "История не найдена" }, { status: 404, headers });
    const jobs = await prisma.avatarGeneration.findMany({ where: { userId, scope: storySceneScope(threadId), state: "succeeded",
      imageUrl: { not: null } }, orderBy: { createdAt: "desc" }, take: STORY_SCENE_GALLERY_LIMIT,
      select: { id: true, imageUrl: true, createdAt: true } });
    const scenes: StorySceneItem[] = jobs.filter(job => job.imageUrl === storySceneImagePath(threadId, job.id)).map(job => ({
      jobId: job.id, url: storySceneImagePath(threadId, job.id), thumbUrl: storySceneThumbPath(threadId, job.id),
      createdAt: job.createdAt.toISOString(),
    }));
    return NextResponse.json({ scenes, limit: STORY_SCENE_GALLERY_LIMIT }, { headers });
  } catch (error) {
    errorLog("Server", "[StoryScene] gallery failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось загрузить иллюстрации" }, { status: 500, headers });
  }
}
