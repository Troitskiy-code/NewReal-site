import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { guessArtStyle, visionArtStyle } from "@/lib/characterArtStyle";

export const maxDuration = 120;

const LOG = "Admin:CharacterArtStyle";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 40;

function isAuthorized(req: NextRequest): boolean {
  const adminSecret = process.env['ADMIN_SECRET'];
  if (!adminSecret) return false;
  const authorization = req.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  return req.headers.get("x-admin-secret") === adminSecret || bearer === adminSecret;
}

/**
 * Fills Character.artStyle for public cards that have none. Dry run by default.
 * POST { mode: "heuristic" | "vision", dryRun?: boolean, limit?: number }; vision also reports the keyword guess.
 * Writes never touch updatedAt (it versions the avatar URL) and never overwrite a style set meanwhile.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { mode?: unknown; dryRun?: unknown; limit?: unknown };
  const mode = body.mode === "vision" ? "vision" : "heuristic";
  const dryRun = body.dryRun !== false;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(Number(body.limit) || DEFAULT_LIMIT)));
  if (mode === "vision" && !process.env['DEEPINFRA_API_KEY']?.trim()) return NextResponse.json({ error: "DEEPINFRA_API_KEY is not configured" }, { status: 503 });

  const rows = await prisma.character.findMany({
    where: { isPublic: true, slug: { not: null }, artStyle: null, imageUrl: { not: null } },
    orderBy: [{ totalMessages: "desc" }, { id: "asc" }], take: limit,
    select: { id: true, name: true, tags: true, avatarPrompt: true, ...(mode === "vision" ? { imageUrl: true } : {}) },
  });
  const remaining = await prisma.character.count({ where: { isPublic: true, slug: { not: null }, artStyle: null, imageUrl: { not: null } } });
  const results = [];
  for (const row of rows) {
    const guess = guessArtStyle(row.tags, row.avatarPrompt);
    let style = guess, answer: string | undefined, error: string | undefined;
    if (mode === "vision") {
      try {
        const vision = await visionArtStyle((row as { imageUrl: string }).imageUrl);
        style = vision.style; answer = vision.answer;
      } catch (cause) {
        style = null; error = "vision_failed";
        errorLog(LOG, "vision request", { characterId: row.id, ...toSafeDiagnostic(cause) });
      }
    }
    let saved = false;
    if (!dryRun && style) {
      saved = await prisma.$executeRaw`UPDATE "Character" SET "artStyle" = ${style} WHERE "id" = ${row.id} AND "artStyle" IS NULL` > 0;
    }
    results.push({ id: row.id, name: row.name, guess, style, ...(answer !== undefined ? { answer } : {}), ...(error ? { error } : {}), saved });
  }
  const summary = { mode, dryRun, checked: results.length, remainingBefore: remaining, saved: results.filter(item => item.saved).length,
    anime: results.filter(item => item.style === "anime").length, realistic: results.filter(item => item.style === "realistic").length,
    unknown: results.filter(item => !item.style).length,
    ...(mode === "vision" ? { disagreements: results.filter(item => item.guess && item.style && item.guess !== item.style).length } : {}) };
  infoLog(LOG, "run", summary);
  return NextResponse.json({ ...summary, results });
}
