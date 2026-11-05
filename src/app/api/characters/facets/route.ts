import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { catalogAdultHiddenCondition, catalogSearchCondition } from "@/lib/characterCatalogSearch";
import { computeCatalogFacets, parseCatalogFilters } from "@/lib/catalogFilters";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { telegramCharacterWhere } from "@/lib/telegram/catalog";

/** What each filter option would leave in the public catalog: live counts and dead ends for the panel. */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const session = await getServerSession(authOptions);
    const telegramWhere = await telegramCharacterWhere(session?.user?.id);
    const rows = await prisma.character.findMany({
      where: { AND: [
        { isPublic: true, slug: { not: null } },
        catalogSearchCondition(searchParams.get("search") ?? ""),
        ...(searchParams.get("adult") === "hide" ? [catalogAdultHiddenCondition] : []),
        ...(telegramWhere ? [telegramWhere as Record<string, unknown>] : []),
      ] },
      select: { tags: true, artStyle: true, roleplayMode: true },
    });
    return NextResponse.json(computeCatalogFacets(rows, parseCatalogFilters((key) => searchParams.get(key))),
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    errorLog("Server", "Catalog facets error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
