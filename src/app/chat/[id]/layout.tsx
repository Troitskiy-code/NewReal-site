import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { chatPageMetadata, createPageMetadata } from "@/lib/seo";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { translate } from "@/lib/getDictionary";

type ChatLayoutProps = {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: ChatLayoutProps): Promise<Metadata> {
  const { id } = await params;
  const locale = await getRequestLocale();

  try {
    const character = await prisma.character.findUnique({
      where: { id },
      select: { name: true },
    });

    if (character?.name) {
      return chatPageMetadata(character.name, locale);
    }
  } catch (error) {
    console.error("Failed to load character metadata:", error);
  }

  return createPageMetadata(
    translate(locale, "meta.chat.title", { name: "NewVerse" }),
    translate(locale, "meta.chat.description", { name: "NewVerse" })
  );
}

export default function ChatLayout({ children }: ChatLayoutProps) {
  return children;
}
