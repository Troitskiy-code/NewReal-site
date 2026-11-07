import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValidThreadId } from "@/lib/chatThreads";
import { readStorySceneImage } from "@/lib/characterMedia";
import { isStorySceneJobId, storySceneImagePath, storySceneScope } from "@/lib/storySceneShared";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex" };

export async function GET(_req: Request, context: { params: Promise<{ threadId: string; jobId: string }> }) {
  try {
    const { threadId, jobId } = await context.params;
    if (!isValidThreadId(threadId) || !isStorySceneJobId(jobId)) return new Response(null, { status: 404, headers });
    const userId = (await getServerSession(authOptions))?.user?.id;
    if (!userId) return new Response(null, { status: 404, headers });
    const thread = await prisma.chatThread.findFirst({ where: { id: threadId, userId }, select: { id: true } });
    if (!thread) return new Response(null, { status: 404, headers });
    const job = await prisma.avatarGeneration.findFirst({ where: { id: jobId, userId, scope: storySceneScope(threadId),
      state: "succeeded", imageUrl: storySceneImagePath(threadId, jobId) }, select: { id: true } });
    if (!job) return new Response(null, { status: 404, headers });
    const image = await readStorySceneImage(userId, threadId, jobId);
    return new Response(image, { headers: { ...headers, "Content-Type": "image/webp", "Content-Length": String(image.byteLength) } });
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404 ? 404 : 503;
    return new Response(null, { status, headers });
  }
}
