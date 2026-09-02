import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { chatPageMetadata, createPageMetadata } from "@/lib/seo";

type ChatLayoutProps = {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: ChatLayoutProps): Promise<Metadata> {
  const { id } = await params;

  try {
    const character = await prisma.character.findUnique({
      where: { id },
      select: { name: true },
    });

    if (character?.name) {
      return chatPageMetadata(character.name);
    }
  } catch (error) {
    console.error("Failed to load character metadata:", error);
  }

  return createPageMetadata(
    "Чат с персонажем — NewVerse",
    "Ролевая игра с ИИ-персонажем. Погрузитесь в историю и развивайте сюжет."
  );
}

export default function ChatLayout({ children }: ChatLayoutProps) {
  return children;
}
