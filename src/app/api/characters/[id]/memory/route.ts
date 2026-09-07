import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  canReadPrivateMemory,
  parseMemoryInput,
  sanitizeCharacterMemory,
} from "@/lib/persistentMemory";
import { Prisma } from "@prisma/client";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    const { id } = await context.params;

    const character = await prisma.character.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        isPublic: true,
        publicMemory: true,
        privateMemory: true,
        memoryPermissions: true,
        lastActive: true,
      },
    });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    const viewerId = session?.user?.id ?? null;
    const isOwner = Boolean(viewerId && viewerId === character.userId);

    if (!isOwner && !character.isPublic) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    const canReadPrivate = canReadPrivateMemory(
      character.memoryPermissions,
      character.userId,
      viewerId
    );
    const sanitized = sanitizeCharacterMemory(character, viewerId);

    console.log(
      `[Memory] GET character=${id} user=${viewerId ?? "anonymous"} private=${canReadPrivate}`
    );

    return NextResponse.json({
      publicMemory: sanitized.publicMemory,
      privateMemory: sanitized.privateMemory,
      memoryPermissions: sanitized.memoryPermissions,
      canEdit: isOwner,
      canReadPrivate,
      lastActive: character.lastActive,
    });
  } catch (error) {
    console.error("[Memory] GET failed", error);
    return NextResponse.json({ error: "Не удалось загрузить память" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id } = await context.params;
    const character = await prisma.character.findUnique({ where: { id } });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    if (character.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    const body = (await req.json()) as Record<string, unknown>;
    const publicMemory = parseMemoryInput(body.publicMemory);
    const privateMemory = parseMemoryInput(body.privateMemory);

    const data: Prisma.CharacterUpdateInput = { lastActive: new Date() };

    if (body.publicMemory !== undefined) data.publicMemory = publicMemory ?? Prisma.DbNull;
    if (body.privateMemory !== undefined) data.privateMemory = privateMemory ?? Prisma.DbNull;

    if (body.publicMemory === undefined && body.privateMemory === undefined) {
      return NextResponse.json({ error: "Нет полей для обновления" }, { status: 400 });
    }

    const updated = await prisma.character.update({
      where: { id },
      data,
    });

    console.log(`[Memory] Updated character=${id} user=${session.user.id}`);

    return NextResponse.json({
      publicMemory: updated.publicMemory,
      privateMemory: updated.privateMemory,
      memoryPermissions: updated.memoryPermissions,
      lastActive: updated.lastActive,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось сохранить память";
    const status = message.includes("лимит") || message.includes("Некорректн") ? 400 : 500;
    console.error("[Memory] PUT failed", error);
    return NextResponse.json({ error: message }, { status });
  }
}
