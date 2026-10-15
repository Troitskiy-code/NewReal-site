import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { characterMediaDownloadUrl, parseCharacterMediaPath } from "@/lib/characterMedia";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { withTelegramCharacterWhere } from "@/lib/telegram/catalog";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, context: { params: Promise<{ owner: string; asset: string }> }) {
  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
  try {
    const { owner, asset } = await context.params;
    const path = `/api/character-media/${owner}/${asset}`;
    const media = parseCharacterMediaPath(path);
    if (!media) return new NextResponse(null, { status: 404, headers });
    // Owner previews do not scan the owner's catalog. Published cards can be viewed anonymously.
    const session = await getServerSession(authOptions);
    if (session?.user?.id !== owner) {
      const published = await prisma.character.findFirst({
        where: await withTelegramCharacterWhere({ userId: owner, isPublic: true, OR: [{ imageUrl: path }, { imageLora: path }] }, session?.user?.id),
        select: { id: true },
      });
      if (!published) return new NextResponse(null, { status: 404, headers });
    }
    // Store the stable app path, never an expiring signature, in the database.
    return new NextResponse(null, { status: 307, headers: { ...headers, Location: await characterMediaDownloadUrl(path) } });
  } catch (error) {
    errorLog("Server", "Character media read failed", toSafeDiagnostic(error));
    return new NextResponse(null, { status: 503, headers });
  }
}
