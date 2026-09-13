import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function parseDataUrl(value: string): { mime: string; body: Buffer } | null {
  const match = value.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return null;
  const mime = match[1]?.trim() || "application/octet-stream";
  const base64 = Boolean(match[2]);
  const payload = match[3] || "";
  const body = Buffer.from(payload, base64 ? "base64" : "utf8");
  return { mime, body };
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const character = await prisma.character.findUnique({
      where: { id },
      select: { imageUrl: true, isPublic: true, userId: true },
    });

    if (!character?.imageUrl) {
      return new NextResponse(null, { status: 404 });
    }

    if (!character.isPublic) {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id || session.user.id !== character.userId) {
        return new NextResponse(null, { status: 404 });
      }
    }

    const imageUrl = character.imageUrl;

    if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://") || imageUrl.startsWith("/")) {
      return NextResponse.redirect(new URL(imageUrl, req.url));
    }

    const parsed = imageUrl.startsWith("data:") ? parseDataUrl(imageUrl) : null;
    if (!parsed) {
      return new NextResponse(null, { status: 404 });
    }

    return new NextResponse(new Uint8Array(parsed.body), {
      headers: {
        "Content-Type": parsed.mime,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    console.error("[characters] avatar GET failed", error);
    return new NextResponse(null, { status: 500 });
  }
}
