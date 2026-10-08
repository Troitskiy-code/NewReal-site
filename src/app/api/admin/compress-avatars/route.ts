import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { tryCompressAvatarDataUrl } from "@/lib/compressAvatar";
import { errorLog, infoLog } from "@/lib/logger";

export const maxDuration = 60;

const LOG = "Admin:CompressAvatars";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_MIN_BYTES = 30_000;

type AvatarRow = {
  id: string;
  name: string;
  imageUrl: string;
};

type Detail = {
  id: string;
  name: string;
  before: { w: number | null; h: number | null; bytes: number };
  after: { w: number | null; h: number | null; bytes: number };
  saved: number;
  skipped: boolean;
  error?: string;
};

function isAuthorized(req: NextRequest): boolean {
  const adminSecret = process.env['ADMIN_SECRET'];
  if (!adminSecret) return false;

  const header = req.headers.get("x-admin-secret");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const authorization = req.headers.get("authorization");
  const bearer =
    authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";

  return header === adminSecret || querySecret === adminSecret || bearer === adminSecret;
}

function unauthorized() {
  return new NextResponse(null, { status: 401 });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return fallback;
}

function parseIntParam(value: unknown, fallback: number, min: number, max?: number): number {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(raw)) return fallback;
  const truncated = Math.trunc(raw);
  if (truncated < min) return fallback;
  return max == null ? truncated : Math.min(max, truncated);
}

function parseString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function avatarWhere(minBytes: number, characterId?: string): Prisma.Sql {
  if (characterId) {
    return Prisma.sql`"id" = ${characterId} AND "imageUrl" LIKE ${"data:image/%"}`;
  }
  return Prisma.sql`"imageUrl" LIKE ${"data:image/%"} AND length("imageUrl") > ${minBytes}`;
}

function savingsPercent(bytesBefore: number, bytesAfter: number): number {
  if (bytesBefore <= 0) return 0;
  return Number(((1 - bytesAfter / bytesBefore) * 100).toFixed(1));
}

async function parseInput(req: NextRequest, forceDryRun: boolean) {
  const query = req.nextUrl.searchParams;
  const body = req.method === "POST" ? asRecord(await req.json().catch(() => ({}))) : {};

  const pick = (key: string) => (body[key] !== undefined ? body[key] : query.get(key));

  return {
    dryRun: forceDryRun ? true : parseBoolean(pick("dryRun"), true),
    limit: parseIntParam(pick("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: parseIntParam(pick("offset"), 0, 0),
    characterId: parseString(pick("characterId")),
    minBytes: parseIntParam(pick("minBytes"), DEFAULT_MIN_BYTES, 0),
  };
}

async function handle(req: NextRequest, forceDryRun: boolean) {
  const started = performance.now();

  if (!isAuthorized(req)) {
    errorLog(LOG, "Unauthorized");
    return unauthorized();
  }

  const { dryRun, limit, offset, characterId, minBytes } = await parseInput(req, forceDryRun);
  const where = avatarWhere(minBytes, characterId);

  infoLog(LOG, "Start", { dryRun, limit, offset, characterId: characterId ?? null, minBytes });

  const [countRow] = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count
    FROM "Character"
    WHERE ${where}
  `;
  const total = Number(countRow?.count ?? 0);

  const rows = await prisma.$queryRaw<AvatarRow[]>`
    SELECT id, name, "imageUrl"
    FROM "Character"
    WHERE ${where}
    ORDER BY id ASC
    LIMIT ${limit}
    OFFSET ${characterId ? 0 : offset}
  `;

  let processed = 0;
  let skipped = 0;
  let errors = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  const details: Detail[] = [];

  for (const row of rows) {
    try {
      const result = await tryCompressAvatarDataUrl(row.imageUrl);
      const before = {
        w: result.beforeWidth,
        h: result.beforeHeight,
        bytes: result.beforeBytes,
      };
      const after = {
        w: result.afterWidth,
        h: result.afterHeight,
        bytes: result.afterBytes,
      };

      if (result.skipReason === "error") {
        errors += 1;
        details.push({
          id: row.id,
          name: row.name,
          before,
          after: before,
          saved: 0,
          skipped: true,
          error: "compress failed",
        });
        errorLog(LOG, "Compress failed", { id: row.id, name: row.name });
        continue;
      }

      if (!result.changed) {
        skipped += 1;
        details.push({
          id: row.id,
          name: row.name,
          before,
          after,
          saved: 0,
          skipped: true,
        });
        continue;
      }

      if (!dryRun) {
        await prisma.character.update({
          where: { id: row.id },
          data: { imageUrl: result.imageUrl },
        });
      }

      processed += 1;
      bytesBefore += result.beforeBytes;
      bytesAfter += result.afterBytes;
      details.push({
        id: row.id,
        name: row.name,
        before,
        after,
        saved: result.beforeBytes - result.afterBytes,
        skipped: false,
      });
    } catch (error) {
      errors += 1;
      const message = "Операция временно недоступна";
      const size = Buffer.byteLength(row.imageUrl, "utf8");
      details.push({
        id: row.id,
        name: row.name,
        before: { w: null, h: null, bytes: size },
        after: { w: null, h: null, bytes: size },
        saved: 0,
        skipped: true,
        error: message,
      });
      errorLog(LOG, "Character failed", { id: row.id, name: row.name, error: message });
    }
  }

  const elapsedMs = Math.round(performance.now() - started);
  const payload = {
    dryRun,
    processed,
    skipped,
    errors,
    total,
    offset: characterId ? 0 : offset,
    limit,
    hasMore: characterId ? false : offset + rows.length < total,
    bytesBefore,
    bytesAfter,
    savingsPercent: savingsPercent(bytesBefore, bytesAfter),
    details,
    elapsedMs,
  };

  const attempted = processed + skipped + errors;
  if (attempted > 0 && errors * 2 > attempted) {
    errorLog(LOG, "Too many errors", payload);
    return NextResponse.json(
      { error: "Сжатие аватаров прервано: слишком много ошибок", ...payload },
      { status: 500 }
    );
  }

  infoLog(LOG, "Done", {
    dryRun,
    processed,
    skipped,
    errors,
    total,
    savingsPercent: payload.savingsPercent,
    elapsedMs,
  });

  return NextResponse.json(payload);
}

export async function GET(req: NextRequest) {
  try {
    return await handle(req, true);
  } catch (error) {
    errorLog(LOG, "GET failed", error);
    return NextResponse.json({ error: "Ошибка сжатия аватаров" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    return await handle(req, false);
  } catch (error) {
    errorLog(LOG, "POST failed", error);
    return NextResponse.json({ error: "Ошибка сжатия аватаров" }, { status: 500 });
  }
}
