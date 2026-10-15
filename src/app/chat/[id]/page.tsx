import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { characterAvatarPath } from "@/lib/characterCardImage";
import ChatPageClient from "./ChatPageClient";
import { getViewerId } from "@/lib/characterPublic";
import { isCharacterAllowedInTelegram } from "@/lib/telegram/catalog";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function ChatPage({ params }: PageProps) {
  const { id } = await params;
  if (!id) notFound();

  const character = await prisma.character.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      name_en: true,
      updatedAt: true,
      userId: true,
    },
  });

  if (!character) notFound();
  // Telegram shows only the approved catalog (and the viewer's own characters).
  if (!(await isCharacterAllowedInTelegram(character, await getViewerId()))) notFound();

  return (
    <ChatPageClient
      initialShell={{
        id: character.id,
        name: character.name,
        name_en: character.name_en,
        avatarUrl: characterAvatarPath(character.id, character.updatedAt),
      }}
    />
  );
}
