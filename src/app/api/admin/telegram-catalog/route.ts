import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { secretEquals, telegramJson } from "@/lib/telegram/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only view of the public catalog shared with Telegram. Same access as other admin tools:
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
    const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
    const where = {
      isPublic: true,
      slug: { not: null },
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { name_en: { contains: q, mode: "insensitive" as const } }] } : {}),
    };
    const [total, listedTotal, rows] = await Promise.all([
      prisma.character.count({ where }),
      prisma.character.count({ where: { isPublic: true, slug: { not: null } } }),
      prisma.character.findMany({
        where,
        select: { id: true, name: true, slug: true, tags: true, totalMessages: true },
        orderBy: [{ totalMessages: "desc" }, { id: "asc" }],
        skip: (page - 1) * PAGE,
        take: PAGE,
      }),
    ]);
    return telegramJson({
      mode: "public", total, listedTotal, page, pages: Math.max(1, Math.ceil(total / PAGE)),
      characters: rows.map((row) => ({ ...row, listed: true })),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await adminId(req);
    if (!admin) return telegramJson({ error: "Недостаточно прав" }, 401);
    return telegramJson({
      error: "Telegram использует весь публичный каталог. Управляйте публикацией в редакторе персонажа.",
      mode: "public",
    }, 410);
  } catch (error) {
    return failure(error);
  }
}
