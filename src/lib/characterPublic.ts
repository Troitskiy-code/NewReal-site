import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildCharacterSlug } from "@/lib/characterSlug";
import { ensureCharacterSlugColumn } from "@/lib/ensureCharacterSlug";

export const publicCharacterSelect = {
  id: true,
  slug: true,
  name: true,
  name_en: true,
  description: true,
  description_en: true,
  descriptionCard: true,
  descriptionCard_en: true,
  imageUrl: true,
  publicMemory: true,
  publicMemory_en: true,
  totalMessages: true,
  createdAt: true,
  isPublic: true,
  userId: true,
  user: {
    select: {
      name: true,
      image: true,
    },
  },
} as const;

export type PublicCharacterRecord = {
  id: string;
  slug: string;
  name: string;
  name_en: string | null;
  description: string | null;
  description_en: string | null;
  descriptionCard: string | null;
  descriptionCard_en: string | null;
  imageUrl: string | null;
  publicMemory: unknown;
  publicMemory_en: unknown;
  totalMessages: number;
  createdAt: Date;
  isPublic: boolean;
  user: {
    name: string | null;
    image: string | null;
  };
};

export async function allocateCharacterSlug(name: string, characterId: string): Promise<string> {
  const preferred = buildCharacterSlug(name, characterId);
  const clash = await prisma.character.findUnique({
    where: { slug: preferred },
    select: { id: true },
  });
  if (!clash || clash.id === characterId) return preferred;

  for (let n = 2; n < 50; n += 1) {
    const candidate = buildCharacterSlug(name, characterId, String(n));
    const existing = await prisma.character.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!existing || existing.id === characterId) return candidate;
  }

  return `${preferred}-${Date.now().toString(36)}`;
}

export async function findCharacterBySlugForViewer(
  slug: string,
  viewerId: string | null
): Promise<PublicCharacterRecord | null> {
  await ensureCharacterSlugColumn();
  const character = await prisma.character.findUnique({
    where: { slug },
    select: publicCharacterSelect,
  });

  if (!character) return null;

  const isOwner = Boolean(viewerId && viewerId === character.userId);
  if (!character.isPublic && !isOwner) return null;
  if (!character.slug) return null;

  return {
    id: character.id,
    slug: character.slug,
    name: character.name,
    name_en: character.name_en,
    description: character.description,
    description_en: character.description_en,
    descriptionCard: character.descriptionCard,
    descriptionCard_en: character.descriptionCard_en,
    imageUrl: character.imageUrl,
    publicMemory: character.publicMemory,
    publicMemory_en: character.publicMemory_en,
    totalMessages: character.totalMessages,
    createdAt: character.createdAt,
    isPublic: character.isPublic,
    user: character.user,
  };
}

export async function getViewerId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return session?.user?.id ?? null;
}

export function toPublicCharacterPayload(character: PublicCharacterRecord) {
  return {
    id: character.id,
    slug: character.slug,
    name: character.name,
    name_en: character.name_en,
    description: character.description,
    description_en: character.description_en,
    descriptionCard: character.descriptionCard,
    descriptionCard_en: character.descriptionCard_en,
    imageUrl: character.imageUrl,
    publicMemory: character.publicMemory,
    publicMemory_en: character.publicMemory_en,
    totalMessages: character.totalMessages,
    createdAt: character.createdAt,
    user: character.user,
  };
}
