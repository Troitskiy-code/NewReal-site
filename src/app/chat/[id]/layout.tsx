import { cache } from "react";
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { chatPageMetadata, createPageMetadata } from "@/lib/seo";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { translate } from "@/lib/getDictionary";
import { getViewerId } from "@/lib/characterPublic";
import { isCharacterAllowedInTelegram } from "@/lib/telegram/catalog";
import { isTelegramContext } from "@/lib/telegram/context";

type ChatLayoutProps = {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
};

export const viewport: Viewport = {
  interactiveWidget: "resizes-visual",
};

const loadChatCharacter = cache(async (id: string) => {
  try {
    return await prisma.character.findUnique({ where: { id }, select: { id: true, name: true, userId: true } });
  } catch (error) {
    console.error("Failed to load character metadata:", error);
    return null;
  }
});

/** Telegram Mini App: a character outside the Telegram catalog does not exist (404). */
async function assertVisibleInTelegram(id: string) {
  if (!(await isTelegramContext())) return;
  const character = await loadChatCharacter(id);
  if (character && !(await isCharacterAllowedInTelegram(character, await getViewerId()))) notFound();
}

export async function generateMetadata({ params }: ChatLayoutProps): Promise<Metadata> {
  const { id } = await params;
  const locale = await getRequestLocale();
  // Also here, so the title never carries the name of a hidden character.
  await assertVisibleInTelegram(id);
  const character = await loadChatCharacter(id);

  if (character?.name) {
    return chatPageMetadata(character.name, locale);
  }

  return createPageMetadata(
    translate(locale, "meta.chat.title", { name: "NewVerse" }),
    translate(locale, "meta.chat.description", { name: "NewVerse" })
  );
}

// The layout renders before the page's loading.tsx boundary, so notFound() here still sets
// HTTP 404 instead of a streamed 200.
export default async function ChatLayout({ children, params }: ChatLayoutProps) {
  await assertVisibleInTelegram((await params).id);
  return children;
}
