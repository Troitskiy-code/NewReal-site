import { publicError } from "@/lib/publicError";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { applyPermissionGrant } from "@/lib/persistentMemory";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id } = await context.params;
    const character = await prisma.character.findUnique({
      where: { id },
      select: { id: true, userId: true, memoryPermissions: true },
    });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    if (character.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    const body = (await req.json()) as Record<string, unknown>;
    const memoryPermissions = applyPermissionGrant(character.memoryPermissions, body);

    const updated = await prisma.character.update({
      where: { id },
      data: {
        memoryPermissions,
        lastActive: new Date(),
      },
      select: {
        id: true,
        memoryPermissions: true,
        lastActive: true,
      },
    });

    console.log(
      `[Memory] Permissions updated character=${id} user=${session.user.id} readers=${memoryPermissions.privateAccessUserIds.length}`
    );

    return NextResponse.json({ memoryPermissions: updated.memoryPermissions });
  } catch (error) {
    const { message, status } = publicError(error, "Не удалось обновить разрешения");
    errorLog("Server", "[Memory] Permissions update failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: message }, { status });
  }
}
