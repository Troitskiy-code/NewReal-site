import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { getViewerId } from "@/lib/characterPublic";
import { characterAvatarPath } from "@/lib/characterCardImage";
import { DEFAULT_CHARACTER_SORT, isCharacterSort } from "@/lib/characterSort";
import { CHARACTERS_PAGE_LIMIT } from "@/lib/charactersList";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import type { SeoSearchParams } from "@/lib/seoIndexing";

export function parseCatalogQuery(params: SeoSearchParams) {
  const first = (key: string) => { const value = params[key]; return (Array.isArray(value) ? value[0] : value) ?? ""; };
  const value = first("sort");
  const sort = isCharacterSort(value) ? value : DEFAULT_CHARACTER_SORT;
  const page = Math.max(1, Number.parseInt(first("page"), 10) || 1);
  return { sort, page, search: first("q").trim().slice(0, 200) };
}

// React cache is per render/request, not a shared cache of personalized favorites.
export const getPublicCatalog = cache(async (sort: string, page: number, search: string) => {
  try {
    const where = {
      isPublic: true, slug: { not: null },
      ...(search ? { OR: [
        { name: { contains: search, mode: "insensitive" as const } },
        { name_en: { contains: search, mode: "insensitive" as const } },
        { tags: { contains: search, mode: "insensitive" as const } },
      ] } : {}),
    };
    const limit = CHARACTERS_PAGE_LIMIT;
    const total = await prisma.character.count({ where });
    const select = {
      id: true, slug: true, name: true, name_en: true, description: true, description_en: true,
      descriptionCard: true, descriptionCard_en: true, totalMessages: true, updatedAt: true,
    } as const;
    let rows;
    if (sort === "random") {
      const ids = await prisma.character.findMany({ where, select: { id: true } });
      const chosen = ids.sort(() => Math.random() - 0.5).slice((page - 1) * limit, page * limit).map(row => row.id);
      const data = await prisma.character.findMany({ where: { ...where, id: { in: chosen } }, select });
      rows = chosen.flatMap(id => { const row = data.find(item => item.id === id); return row ? [row] : []; });
    } else {
      rows = await prisma.character.findMany({ where, select, skip: (page - 1) * limit, take: limit,
        orderBy: sort === "top" || sort === "for-you"
          ? [{ totalMessages: "desc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "asc" }],
      });
    }
    const viewerId = await getViewerId();
    const favorites = viewerId && rows.length ? await prisma.favorite.findMany({
      where: { userId: viewerId, characterId: { in: rows.map(row => row.id) } }, select: { characterId: true },
    }) : [];
    const favoriteIds = new Set(favorites.map(row => row.characterId));
    return {
      data: rows.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString(),
        imageUrl: characterAvatarPath(row.id, row.updatedAt), isPublic: true, isFavorited: favoriteIds.has(row.id),
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) }, search,
    };
  } catch (error) {
    errorLog("Catalog", "server listing", toSafeDiagnostic(error));
    throw new Error("Public catalog temporarily unavailable");
  }
});
