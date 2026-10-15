import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { secretEquals, telegramJson } from "@/lib/telegram/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner's selection of characters shown in Telegram. Same access as other admin tools:
// ADMIN_SECRET in the Authorization header plus a signed-in account.

const PAGE = 30;

async function adminId(req: NextRequest): Promise<string | null> {
  const provided = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
  if (!secretEquals(process.env.ADMIN_SECRET?.trim() || null, provided)) return null;
  const session = await getServerSession(authOptions);
  return session?.user?.id ?? null;
}

function failure(error: unknown) {
  if (["P2021", "P2022"].includes((error as { code?: string }).code ?? "")) {
    return telegramJson({ error: "Примените миграцию 20261014180000_telegram_miniapp.", migrationRequired: true }, 503);
  }
  errorLog("TelegramCatalog", "admin request failed", toSafeDiagnostic(error));
  return telegramJson({ error: "Не удалось выполнить запрос. Повторите." }, 500);
}

export async function GET(req: NextRequest) {
  try {
    if (!(await adminId(req))) return telegramJson({ error: "Войдите в аккаунт и укажите ключ администратора" }, 401);
    const params = req.nextUrl.searchParams;
    const q = (params.get("q") ?? "").trim().slice(0, 100);
    const filter = params.get("filter") === "listed" ? "listed" : "all";
    const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
    const where = {
      isPublic: true,
      slug: { not: null },
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { name_en: { contains: q, mode: "insensitive" as const } }] } : {}),
      ...(filter === "listed" ? { telegramCatalogEntry: { isNot: null } } : {}),
    };
    const [total, listedTotal, rows] = await Promise.all([
      prisma.character.count({ where }),
      prisma.telegramCatalogEntry.count(),
      prisma.character.findMany({
        where,
        select: { id: true, name: true, slug: true, tags: true, totalMessages: true, telegramCatalogEntry: { select: { createdAt: true } } },
        orderBy: [{ totalMessages: "desc" }, { id: "asc" }],
        skip: (page - 1) * PAGE,
        take: PAGE,
      }),
    ]);
    return telegramJson({
      total, listedTotal, page, pages: Math.max(1, Math.ceil(total / PAGE)),
      characters: rows.map(({ telegramCatalogEntry, ...row }) => ({ ...row, listed: Boolean(telegramCatalogEntry) })),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await adminId(req);
    if (!admin) return telegramJson({ error: "Недостаточно прав" }, 401);
    const raw = await req.text();
    if (raw.length > 2048) return telegramJson({ error: "Запрос слишком большой" }, 413);
    let body: { characterId?: unknown; listed?: unknown };
    try { body = JSON.parse(raw); } catch { return telegramJson({ error: "Некорректный запрос" }, 400); }
    const characterId = typeof body.characterId === "string" ? body.characterId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(characterId) || typeof body.listed !== "boolean") {
      return telegramJson({ error: "Некорректный запрос" }, 400);
    }
    if (body.listed) {
      const character = await prisma.character.findUnique({ where: { id: characterId }, select: { isPublic: true } });
      if (!character) return telegramJson({ error: "Персонаж не найден" }, 404);
      if (!character.isPublic) return telegramJson({ error: "В подборку Telegram можно добавить только публичного персонажа" }, 409);
      await prisma.telegramCatalogEntry.upsert({ where: { characterId }, create: { characterId, addedById: admin }, update: {} });
    } else {
      await prisma.telegramCatalogEntry.deleteMany({ where: { characterId } });
    }
    infoLog("TelegramCatalog", body.listed ? "added" : "removed", { characterId });
    return telegramJson({ ok: true, characterId, listed: body.listed });
  } catch (error) {
    return failure(error);
  }
}
