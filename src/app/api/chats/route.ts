import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type ChatSummary = {
  character: {
    id: string;
    name: string;
    imageUrl: string | null;
    description: string | null;
    descriptionCard: string | null;
  };
  lastMessage: {
    id: string;
    role: string;
    content: string;
    createdAt: Date;
  };
  count: number;
  lastActivity: Date;
};

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const messages = await prisma.message.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      include: {
        character: {
          select: {
            id: true,
            name: true,
            imageUrl: true,
            description: true,
            descriptionCard: true,
          },
        },
      },
    });

    const chatsMap = new Map<string, ChatSummary>();

    for (const message of messages) {
      const existing = chatsMap.get(message.characterId);
      if (!existing) {
        chatsMap.set(message.characterId, {
          character: message.character,
          lastMessage: {
            id: message.id,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
          },
          count: 1,
          lastActivity: message.createdAt,
        });
      } else {
        existing.count += 1;
      }
    }

    const data = Array.from(chatsMap.values()).sort(
      (a, b) => b.lastActivity.getTime() - a.lastActivity.getTime()
    );

    return NextResponse.json({ data });
  } catch (error) {
    console.error("Chats GET error:", error);
    return NextResponse.json({ error: "Ошибка получения чатов" }, { status: 500 });
  }
}
