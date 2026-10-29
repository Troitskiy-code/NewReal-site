import { isCharacterAllowedInTelegram } from "@/lib/telegram/catalog";
import { chatTranslationSelect } from "@/lib/characterLocalization";
import { ClientInputError } from "@/lib/publicError";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { withAiCostContext, setAiCostActor } from "@/lib/aiCostTelemetry";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CHARACTER_LIMITS, parseCharacterBody } from "@/lib/characterFields";
import { persistCharacterImage, CharacterMediaUnavailable } from "@/lib/characterMedia";
import { validateGroupConfig } from "@/lib/roleplayConfig";
import { enqueueCharacterTranslations, saveManualEnglishTranslation } from "@/lib/characterTranslationQueue";
import { sanitizeCharacterMemory } from "@/lib/persistentMemory";
import { allocateCharacterSlug } from "@/lib/characterPublic";
import { ensureCharacterSlugColumn } from "@/lib/ensureCharacterSlug";
import { ensureCharacterModerationColumns } from "@/lib/ensureCharacterModerationColumns";
import { ownerModerationFields, stripModerationFields } from "@/lib/characterModeration";
import { Prisma } from "@prisma/client";
import { scheduleIndexNowChange } from "@/lib/indexNow";

export const maxDuration = 60;

type RouteContext = {
  params: Promise<{ id: string }>;
};

async function getAuthorizedCharacter(id: string, userId: string) {
  const character = await prisma.character.findUnique({ where: { id } });

  if (!character) {
    return { error: NextResponse.json({ error: "Персонаж не найден" }, { status: 404 }) };
  }

  if (character.userId !== userId) {
    return { error: NextResponse.json({ error: "Доступ запрещён" }, { status: 403 }) };
  }

  return { character };
}

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    await ensureCharacterSlugColumn();
    await ensureCharacterModerationColumns();
    const { id } = await context.params;
    const session = await getServerSession(authOptions);

    const character = await prisma.character.findUnique({ where: { id }, include: { translations: { select: chatTranslationSelect } } });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    const isOwner = Boolean(session?.user?.id && session.user.id === character.userId);

    if (!isOwner && !character.isPublic) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }
    if (!(await isCharacterAllowedInTelegram(character, session?.user?.id))) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    const sanitized = stripModerationFields(
      sanitizeCharacterMemory(character, session?.user?.id ?? null)
    );
    const payload = isOwner
      ? { ...sanitized, ...ownerModerationFields(character, session?.user?.id) }
      : sanitized;

    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    errorLog("Server", "Character fetch error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAiCostContext(() => handleCostedRequest(req, context));
}

async function handleCostedRequest(req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }
    setAiCostActor(session.user.id);

    await ensureCharacterSlugColumn();
    await ensureCharacterModerationColumns();

    const { id } = await context.params;
    const authResult = await getAuthorizedCharacter(id, session.user.id);
    if (authResult.error) return authResult.error;

    const body = await req.json();

    let parsed;
    try {
      parsed = parseCharacterBody(body);
      validateGroupConfig(body.roleplayMode === undefined ? authResult.character.roleplayMode : parsed.roleplayMode,
        body.rpConfig === undefined ? authResult.character.rpConfig : parsed.rpConfig);
    } catch (err) {
      const message = err instanceof ClientInputError ? err.message : "Некорректные данные";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // TODO: auto-moderate edited characters via a KodikRouter moderator model. Manual admin API for now.

    const data: Prisma.CharacterUpdateInput = {};

    if (body.name !== undefined) {
      if (!parsed.name) {
        return NextResponse.json({ error: "Имя обязательно" }, { status: 400 });
      }
      data.name = parsed.name;
      if (parsed.name !== authResult.character.name) {
        data.slug = await allocateCharacterSlug(parsed.name, id);
      }
    }

    if (body.description !== undefined) data.description = parsed.description ?? null;
    if (body.descriptionCard !== undefined) data.descriptionCard = parsed.descriptionCard ?? null;
    if (body.appearance !== undefined) data.appearance = parsed.appearance ?? null;
    if (body.tags !== undefined) data.tags = parsed.tags ?? null;
    if (body.imageUrl !== undefined) {
      data.imageUrl = await persistCharacterImage(parsed.imageUrl, session.user.id, authResult.character.imageUrl);
    }
    if (body.imageLora !== undefined) data.imageLora = await persistCharacterImage(parsed.imageLora, session.user.id, authResult.character.imageLora);
    if (body.greeting !== undefined) data.greeting = parsed.greeting ?? null;
    if (body.scenario !== undefined) data.scenario = parsed.scenario ?? null;
    if (body.exampleDialogs !== undefined) data.exampleDialogs = parsed.exampleDialogs ?? null;
    if (body.avatarPrompt !== undefined) data.avatarPrompt = parsed.avatarPrompt ?? null;
    if (body.artStyle !== undefined) data.artStyle = parsed.artStyle;
    if (body.isPublic !== undefined) data.isPublic = parsed.isPublic;
    if (body.publicMemory !== undefined) data.publicMemory = parsed.publicMemory ?? Prisma.DbNull;
    if (body.privateMemory !== undefined) data.privateMemory = parsed.privateMemory ?? Prisma.DbNull;
    if (body.memoryPermissions !== undefined) {
      data.memoryPermissions = parsed.memoryPermissions ?? Prisma.DbNull;
    }

    // System instructions are assembled from fields; the stored archive is immutable.
    if (body.systemPrompt !== undefined && body.systemPrompt !== null && body.systemPrompt !== "") {
      return NextResponse.json({ error: "Изменяйте описание и настройки карточки вместо готовых системных инструкций." }, { status: 400 });
    }
    if (Object.keys(data).length || body.roleplayMode !== undefined || body.roleplayStyle !== undefined || body.rpConfig !== undefined) data.promptBuilderVersion = 2;
    if (body.roleplayMode !== undefined) data.roleplayMode = parsed.roleplayMode;
    if (body.roleplayStyle !== undefined) data.roleplayStyle = parsed.roleplayStyle;
    if (body.rpConfig !== undefined) data.rpConfig = parsed.rpConfig;

    // A failed/empty translation must never make an old EN card override a fresh edit.
    const enFields = ["name", "description", "descriptionCard", "appearance", "greeting", "scenario", "exampleDialogs", "avatarPrompt"] as const;
    // Full editor forms also submit unchanged text when only the image/settings changed.
    // Keep its translations rather than paying to translate the identical source again.
    for (const field of enFields) if (data[field] === authResult.character[field]) delete data[field];
    const stableJson = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
    if (body.publicMemory !== undefined && stableJson(parsed.publicMemory ?? null) === stableJson(authResult.character.publicMemory ?? null)) delete data.publicMemory;
    if (body.privateMemory !== undefined && stableJson(parsed.privateMemory ?? null) === stableJson(authResult.character.privateMemory ?? null)) delete data.privateMemory;
    for (const field of enFields) {
      if (data[field] !== undefined) Object.assign(data, { [`${field}_en`]: null });
    }
    // An editor may supply the English text itself (machine translation confuses pronouns and names);
    // such a field is not sent to the translator.
    const enOverrides: Partial<Record<(typeof enFields)[number], string | null>> = {};
    for (const field of enFields) {
      const value = body[`${field}_en`];
      if (value === undefined) continue;
      if (value !== null && typeof value !== "string") return NextResponse.json({ error: `Поле ${field}_en должно быть строкой` }, { status: 400 });
      const limit = field === "name" ? 80 : CHARACTER_LIMITS[field];
      if (typeof value === "string" && value.trim().length > limit) return NextResponse.json({ error: `Поле ${field}_en: максимум ${limit} символов` }, { status: 400 });
      enOverrides[field] = typeof value === "string" ? value.trim() || null : null;
      Object.assign(data, { [`${field}_en`]: enOverrides[field] });
    }
    if (data.publicMemory !== undefined) data.publicMemory_en = Prisma.DbNull;
    if (data.privateMemory !== undefined) data.privateMemory_en = Prisma.DbNull;

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Нет полей для обновления" }, { status: 400 });
    }

    const character = await prisma.character.update({
      where: { id },
      data: {
        ...data,
        ...(body.publicMemory !== undefined ||
        body.privateMemory !== undefined ||
        body.memoryPermissions !== undefined
          ? { lastActive: new Date() }
          : {}),
      },
    });

    try {
      if (Object.keys(enOverrides).length) await saveManualEnglishTranslation(character,enOverrides);
      await enqueueCharacterTranslations(character.id);
    } catch (translateError) {
      errorLog("Server", "[Translate] Queue discovery will retry", toSafeDiagnostic(translateError));
    }

    if (
      body.publicMemory !== undefined ||
      body.privateMemory !== undefined ||
      body.memoryPermissions !== undefined
    ) {
      console.log(`[Memory] Updated via character PUT character=${id} user=${session.user.id}`);
    }

    scheduleIndexNowChange(authResult.character, character);
    return NextResponse.json({
      ...stripModerationFields(sanitizeCharacterMemory(character, session.user.id)),
      ...ownerModerationFields(character, session.user.id),
    });
  } catch (error) {
    if (error instanceof ClientInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof CharacterMediaUnavailable) return NextResponse.json({ error: "Хранилище изображений временно недоступно. Изменения не сохранены." }, { status: 503 });
    errorLog("Server", "Character update error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id } = await context.params;
    const authResult = await getAuthorizedCharacter(id, session.user.id);
    if (authResult.error) return authResult.error;

    await prisma.character.delete({ where: { id } });
    scheduleIndexNowChange(authResult.character, null);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    errorLog("Server", "Character delete error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
