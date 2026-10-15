import { ClientInputError } from "@/lib/publicError";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { withAiCostContext, setAiCostActor } from "@/lib/aiCostTelemetry";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseCharacterBody } from "@/lib/characterFields";
import { persistCharacterImage, CharacterMediaUnavailable } from "@/lib/characterMedia";
import { validateGroupConfig } from "@/lib/roleplayConfig";
import { isCharacterSort, DEFAULT_CHARACTER_SORT } from "@/lib/characterSort";
import { translateCharacterFieldsToEn, translateMemoryFieldToEn } from "@/lib/translate";
import { buildInitialPublicMemory } from "@/lib/persistentMemory";
import { allocateCharacterSlug } from "@/lib/characterPublic";
import { temporaryCharacterSlug } from "@/lib/characterSlug";
import { ensureCharacterSlugColumn, isMissingSlugColumn } from "@/lib/ensureCharacterSlug";
import { clampCharactersPageLimit } from "@/lib/charactersList";
import { characterAvatarPath } from "@/lib/characterCardImage";
import { ensureCharacterModerationColumns } from "@/lib/ensureCharacterModerationColumns";
import { prismaPoolOverloadResponse } from "@/lib/handlePrismaError";
import { catalogSearchCondition } from "@/lib/characterCatalogSearch";
import { characterTagSearchTerms } from "@/lib/characterTags";
import { getCharacterRecommendationOrder } from "@/lib/characterRecommendations";
import { readOnboardingPrefs } from "@/lib/onboardingServer";
import type { RecommendationMode } from "@/lib/characterRecommendationRank";

export const maxDuration = 60;

// ------------------ POST (создание персонажа) ------------------
export async function POST(req: NextRequest) { return withAiCostContext(() => handlePost(req)); }

async function handlePost(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    await ensureCharacterSlugColumn();
    await ensureCharacterModerationColumns();

    setAiCostActor(session.user.id);
    const body = await req.json();
    if (body.systemPrompt !== undefined && body.systemPrompt !== null && body.systemPrompt !== "") {
      return NextResponse.json({ error: "Заполните описание и настройки карточки вместо готовых системных инструкций" }, { status: 400 });
    }

    let parsed;
    try {
      parsed = parseCharacterBody(body);
      validateGroupConfig(parsed.roleplayMode, parsed.rpConfig);
    } catch (err) {
      const message = err instanceof ClientInputError ? err.message : "Некорректные данные";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // TODO: auto-moderate new characters via a KodikRouter moderator model. Manual admin API for now.

    const {
      name,
      description,
      descriptionCard,
      appearance,
      tags,
      imageUrl,
      imageLora,
      isPublic,
      greeting,
      scenario,
      exampleDialogs,
      avatarPrompt,
      publicMemory,
      privateMemory,
      memoryPermissions,
      roleplayMode, roleplayStyle, rpConfig, artStyle,
    } = parsed;

    if (!name) {
      return NextResponse.json({ error: "Имя обязательно" }, { status: 400 });
    }

    const seededPublicMemory = publicMemory ?? buildInitialPublicMemory(name, description);
    const initialPermissions = memoryPermissions ?? { privateAccessUserIds: [] };
    const storedImageUrl = await persistCharacterImage(imageUrl, session.user.id);
    const storedImageLora = await persistCharacterImage(imageLora, session.user.id);

    let character = await prisma.character.create({
      data: {
        name,
        slug: temporaryCharacterSlug(),
        description: description ?? null,
        descriptionCard: descriptionCard ?? null,
        appearance: appearance ?? null,
        tags: tags ?? null,
        imageUrl: storedImageUrl,
        imageLora: storedImageLora,
        greeting: greeting ?? null,
        scenario: scenario ?? null,
        exampleDialogs: exampleDialogs ?? null,
        avatarPrompt: avatarPrompt ?? null,
        isPublic,
        userId: session.user.id,
        publicMemory: seededPublicMemory,
        privateMemory: privateMemory ?? undefined,
        memoryPermissions: initialPermissions,
        lastActive: new Date(),
        promptBuilderVersion: 2,
        roleplayMode, roleplayStyle, rpConfig, artStyle,
      },
    });

    const slug = await allocateCharacterSlug(name, character.id);
    character = await prisma.character.update({
      where: { id: character.id },
      data: { slug },
    });
    console.log(`[Character] Created slug=${slug} id=${character.id}`);

    console.log(
      `[Memory] Seeded public memory for character=${character.id} user=${session.user.id}`
    );

    try {
      const translations = await translateCharacterFieldsToEn({
        name,
        description,
        descriptionCard,
        appearance,
        greeting,
        scenario,
        exampleDialogs,
        avatarPrompt,
      });
      const publicMemoryEn = await translateMemoryFieldToEn(seededPublicMemory);
      const privateMemoryEn = await translateMemoryFieldToEn(privateMemory);

      character = await prisma.character.update({
        where: { id: character.id },
        data: {
          ...translations,
          ...(publicMemoryEn ? { publicMemory_en: publicMemoryEn } : {}),
          ...(privateMemoryEn ? { privateMemory_en: privateMemoryEn } : {}),
        },
      });
    } catch (translateError) {
      errorLog("Server", "[Translate] Failed to save character translations", toSafeDiagnostic(translateError));
    }

    // Prompt assembly is deterministic and uses the live card on each request; no AI generation here.
    return NextResponse.json(character, { status: 201 });
  } catch (error) {
    if (error instanceof ClientInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof CharacterMediaUnavailable) return NextResponse.json({ error: "Хранилище изображений временно недоступно. Персонаж не сохранён." }, { status: 503 });
    errorLog("Server", "Character creation error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}

// ------------------ GET (получение списка персонажей) ------------------
export async function GET(req: NextRequest) {
  const t0 = performance.now();
  console.log("[Characters] handler started at", new Date().toISOString());

  try {
    try {
      const tEnsure = performance.now();
      await ensureCharacterSlugColumn();
      console.log("[Characters] ensure slug", (performance.now() - tEnsure).toFixed(0), "ms");
    } catch (error) {
      errorLog("Server", "[characters] Could not ensure slug column", toSafeDiagnostic(error));
    }

    const tSession = performance.now();
    const session = await getServerSession(authOptions);
    console.log("[Characters] session", (performance.now() - tSession).toFixed(0), "ms");

    const { searchParams } = new URL(req.url);
    const search = (searchParams.get("search") || "").trim().slice(0, 200);
    const tagsParam = searchParams.get("tags") || "";
    const tagParam = searchParams.get("tag") || "";
    const tagList = [
      ...searchParams.getAll("tags"),
      ...tagsParam.split(",").map((t) => t.trim()),
      ...searchParams.getAll("tag"),
      ...tagParam.split(",").map((t) => t.trim()),
    ].filter(Boolean);
    const uniqueTags = [...new Set(tagList.slice(0, 32).flatMap(tag => characterTagSearchTerms(tag.slice(0, 100))))];
    const userId = searchParams.get("userId") || "";
    const publicFlag = searchParams.get("public") ?? searchParams.get("isPublic");
    const isPublic =
      publicFlag === "true" ? true : publicFlag === "false" ? false : undefined;
    const sortParam = searchParams.get("sort") || DEFAULT_CHARACTER_SORT;
    const sort = isCharacterSort(sortParam) ? sortParam : DEFAULT_CHARACTER_SORT;
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
    const limit = clampCharactersPageLimit(parseInt(searchParams.get("limit") || "24", 10));
    const skip = (page - 1) * limit;

    const t1 = performance.now();
    console.log("[Characters] init", (t1 - t0).toFixed(0), "ms");

    const where: Record<string, unknown> = {};

    if (userId) {
      where.userId = userId;

      if (!session?.user?.id || session.user.id !== userId) {
        where.isPublic = true;
      }
    } else if (isPublic === undefined) {
      where.isPublic = true;
    } else {
      where.isPublic = isPublic;
      if (isPublic === false) {
        if (!session?.user?.id) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
        where.userId = session.user.id;
      }
    }

    const andConditions: Record<string, unknown>[] = [{ ...where }];

    if (search) {
      andConditions.push(catalogSearchCondition(search));
    }

    if (uniqueTags.length > 0) {
      andConditions.push({
        OR: uniqueTags.map((tag) => ({
          tags: { contains: tag, mode: "insensitive" },
        })),
      });
    }

    const queryWhere = andConditions.length === 1 ? andConditions[0] : { AND: andConditions };

    const characterCardSelectNoSlug = {
      id: true,
      name: true,
      name_en: true,
      description: true,
      description_en: true,
      descriptionCard: true,
      descriptionCard_en: true,
      tags: true,
      isPublic: true,
      userId: true,
      totalMessages: true,
      createdAt: true,
      updatedAt: true,
      user: {
        select: {
          name: true,
        },
      },
    } as const;

    const characterCardSelect = {
      ...characterCardSelectNoSlug,
      slug: true,
    } as const;

    let characters;
    const tCount = performance.now();
    let total = await prisma.character.count({ where: queryWhere });
    let recommendationMode: RecommendationMode | null = null;
    console.log("[Characters] prisma count", (performance.now() - tCount).toFixed(0), "ms");

    const loadCharacters = async (
      cardSelect: typeof characterCardSelect | typeof characterCardSelectNoSlug
    ) => {
      if (sort === "for-you") {
        const recommendations = await getCharacterRecommendationOrder(queryWhere, session?.user?.id ?? null, new Date(), await readOnboardingPrefs());
        recommendationMode = recommendations.mode;
        total = recommendations.ids.length;
        const ids = recommendations.ids.slice(skip, skip + limit);
        const rows = ids.length ? await prisma.character.findMany({
          where: { AND: [queryWhere, { isPublic: true, slug: { not: null }, id: { in: ids } }] }, select: cardSelect,
        }) : [];
        const byId = new Map(rows.map(row => [row.id, row]));
        return ids.flatMap(id => { const row = byId.get(id); return row ? [row] : []; });
      }
      if (sort === "random") {
        const ids = await prisma.character.findMany({
          where: queryWhere,
          select: { id: true },
        });
        const shuffled = [...ids].sort(() => Math.random() - 0.5);
        const pageIds = shuffled.slice(skip, skip + limit).map((row) => row.id);

        if (pageIds.length === 0) {
          return [];
        }

        const rows = await prisma.character.findMany({
          where: { AND: [queryWhere, { id: { in: pageIds } }] },
          select: cardSelect,
        });
        const byId = new Map(rows.map((row) => [row.id, row]));
        return pageIds
          .map((id) => byId.get(id))
          .filter((row): row is NonNullable<typeof row> => row != null);
      }

      const orderBy =
        sort === "top"
          ? [{ totalMessages: "desc" as const }, { id: "asc" as const }]
          : [{ createdAt: "desc" as const }, { id: "asc" as const }];

      return prisma.character.findMany({
        where: queryWhere,
        orderBy,
        skip,
        take: limit,
        select: cardSelect,
      });
    };

    const t2 = performance.now();
    try {
      characters = await loadCharacters(characterCardSelect);
    } catch (error) {
      if (!isMissingSlugColumn(error)) throw error;
      errorLog("Server", "[characters] Listing without slug column");
      characters = await loadCharacters(characterCardSelectNoSlug);
    }
    const t3 = performance.now();
    console.log("[Characters] prisma query", (t3 - t2).toFixed(0), "ms, count:", characters.length);

    const tFavorites = performance.now();
    let favoriteIds = new Set<string>();
    if (session?.user?.id && characters.length > 0) {
      const favorites = await prisma.favorite.findMany({
        where: {
          userId: session.user.id,
          characterId: { in: characters.map((character) => character.id) },
        },
        select: { characterId: true },
      });
      favoriteIds = new Set(favorites.map((favorite) => favorite.characterId));
    }
    console.log("[Characters] favorites", (performance.now() - tFavorites).toFixed(0), "ms");

    const t4 = performance.now();
    const data = characters.map((character) => ({
      ...character,
      imageUrl: characterAvatarPath(character.id, character.updatedAt),
      user: character.user
        ? {
            name: character.user.name,
            image: null,
          }
        : character.user,
      isFavorited: favoriteIds.has(character.id),
    }));
    const mapMs = (performance.now() - t4).toFixed(0);
    console.log("[Characters] map", mapMs, "ms");

    const tJson = performance.now();
    const payload = {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        recommendationMode,
      },
    };
    const response = NextResponse.json(payload);
    response.headers.set("Cache-Control", "private, no-store");
    const jsonMs = (performance.now() - tJson).toFixed(0);
    const totalMs = (performance.now() - t0).toFixed(0);
    console.log("[Characters] json", jsonMs, "ms");
    console.log("[Characters] total", totalMs, "ms");
    response.headers.set(
      "Server-Timing",
      [
        `init;dur=${(t1 - t0).toFixed(0)}`,
        `prisma;dur=${(t3 - t2).toFixed(0)}`,
        `map;dur=${mapMs}`,
        `total;dur=${totalMs}`,
      ].join(", ")
    );

    return response;
  } catch (error) {
    const overload = prismaPoolOverloadResponse(error);
    if (overload) return overload;
    errorLog("Server", "Error fetching characters:", toSafeDiagnostic(error));
    console.log("[Characters] total", (performance.now() - t0).toFixed(0), "ms");
    return NextResponse.json({ error: "Ошибка получения списка персонажей" }, { status: 500 });
  }
}
