import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isWorldEventType } from "@/lib/persistentMemory";

const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_LOCATION_LENGTH = 200;
const MAX_PARTICIPANTS = 50;

function parseParticipants(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("participants должен быть массивом ID персонажей");
  }
  if (value.length > MAX_PARTICIPANTS) {
    throw new Error(`Не больше ${MAX_PARTICIPANTS} участников`);
  }
  const ids = value
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

function parseImportance(value: unknown): number {
  if (value === undefined || value === null) return 1;
  const importance = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    throw new Error("importance должен быть целым числом от 1 до 5");
  }
  return importance;
}

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    const characterId = req.nextUrl.searchParams.get("characterId")?.trim();

    if (!characterId) {
      return NextResponse.json({ error: "characterId обязателен" }, { status: 400 });
    }

    const character = await prisma.character.findUnique({
      where: { id: characterId },
      select: { id: true, userId: true, isPublic: true },
    });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    const isOwner = Boolean(session?.user?.id && session.user.id === character.userId);
    if (!isOwner && !character.isPublic) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    const events = await prisma.worldEvent.findMany({
      where: {
        OR: [{ characterId }, { participants: { has: characterId } }],
      },
      orderBy: { timestamp: "desc" },
    });

    return NextResponse.json({ events });
  } catch (error) {
    console.error("[Memory] Failed to list world events", error);
    return NextResponse.json({ error: "Не удалось загрузить события" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const body = (await req.json()) as Record<string, unknown>;
    const characterId = typeof body.characterId === "string" ? body.characterId.trim() : "";
    const type = body.type;
    const description =
      typeof body.description === "string" ? body.description.trim() : "";
    const location =
      typeof body.location === "string" ? body.location.trim() || null : body.location === null ? null : undefined;

    if (!characterId) {
      return NextResponse.json({ error: "characterId обязателен" }, { status: 400 });
    }
    if (!isWorldEventType(type)) {
      return NextResponse.json(
        { error: "type должен быть conversation, action, discovery или travel" },
        { status: 400 }
      );
    }
    if (!description) {
      return NextResponse.json({ error: "description обязателен" }, { status: 400 });
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json(
        { error: `description не длиннее ${MAX_DESCRIPTION_LENGTH} символов` },
        { status: 400 }
      );
    }
    if (location && location.length > MAX_LOCATION_LENGTH) {
      return NextResponse.json(
        { error: `location не длиннее ${MAX_LOCATION_LENGTH} символов` },
        { status: 400 }
      );
    }

    let participants: string[];
    let importance: number;
    try {
      participants = parseParticipants(body.participants);
      importance = parseImportance(body.importance);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Некорректные данные";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    if (!participants.includes(characterId)) {
      participants = [characterId, ...participants];
    }

    const author = await prisma.character.findUnique({
      where: { id: characterId },
      select: { id: true, userId: true },
    });

    if (!author) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    const participantRows = participants.length
      ? await prisma.character.findMany({
          where: { id: { in: participants } },
          select: { id: true, userId: true },
        })
      : [];

    const isAuthorOwner = author.userId === session.user.id;
    const isParticipantOwner = participantRows.some((row) => row.userId === session.user.id);

    if (!isAuthorOwner && !isParticipantOwner) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    const event = await prisma.worldEvent.create({
      data: {
        characterId,
        type,
        participants,
        description,
        importance,
        location: location ?? null,
      },
    });

    await prisma.character.update({
      where: { id: characterId },
      data: { lastActive: new Date() },
    });

    console.log(
      `[Memory] WorldEvent created id=${event.id} character=${characterId} type=${type} user=${session.user.id}`
    );

    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    console.error("[Memory] Failed to create world event", error);
    return NextResponse.json({ error: "Не удалось создать событие" }, { status: 500 });
  }
}
