import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { prismaPoolOverloadResponse } from "@/lib/handlePrismaError";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const YEAR_CACHE = "public, max-age=31536000, immutable";

function parseDataUrl(value: string): { mime: string; body: Buffer } | null {
  if (!value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma < 0) return null;
  const header = value.slice("data:".length, comma);
  const payload = value.slice(comma + 1);
  const parts = header.split(";");
  const mime = parts[0]?.trim() || "application/octet-stream";
  const base64 = parts.some((part) => part.trim().toLowerCase() === "base64");
  const body = Buffer.from(payload, base64 ? "base64" : "utf8");
  return { mime, body };
}

function contentTypeFor(mime: string): string | null {
  const lower = mime.toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  return /^image\/(?:jpeg|png|webp|gif|avif|bmp|tiff)$/.test(lower) ? lower : null;
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const character = await prisma.character.findUnique({
      where: { id },
      select: { imageUrl: true, isPublic: true, userId: true, updatedAt: true },
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
    const cacheControl = character.isPublic ? YEAR_CACHE : "private, no-store";

    if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://") || imageUrl.startsWith("/")) {
      const response = NextResponse.redirect(new URL(imageUrl, req.url));
      response.headers.set("Cache-Control", cacheControl);
      return response;
    }

    const parsed = imageUrl.startsWith("data:") ? parseDataUrl(imageUrl) : null;
    const contentType = parsed ? contentTypeFor(parsed.mime) : null;
    if (!parsed || !contentType) {
      return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    }

    return new NextResponse(new Uint8Array(parsed.body), {
      headers: {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": cacheControl,
        "CDN-Cache-Control": cacheControl,
      },
    });
  } catch (error) {
    const overload = prismaPoolOverloadResponse(error);
    if (overload) return overload;
    errorLog("Server", "[characters] avatar GET failed", toSafeDiagnostic(error));
    return new NextResponse(null, { status: 500 });
  }
}
