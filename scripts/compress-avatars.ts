/**
 * Compress Character.imageUrl data URLs to WebP 512 (longest side).
 * Run: node --experimental-strip-types scripts/compress-avatars.ts [--dry-run] [--limit=N]
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { tryCompressAvatarDataUrl } from "../src/lib/compressAvatar.ts";

const dbUrl = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
if (!dbUrl) {
  console.error("Missing DATABASE_URL (or DIRECT_URL) in env. Aborting.");
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: { db: { url: dbUrl } },
});

function parseArgs(argv: string[]) {
  let dryRun = false;
  let limit: number | undefined;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--limit=")) {
      const value = Number.parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isFinite(value) || value < 1) {
        console.error("Invalid --limit. Use a positive integer.");
        process.exit(1);
      }
      limit = value;
    }
  }
  return { dryRun, limit };
}

function formatKb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));
  const characters = await prisma.character.findMany({
    where: { imageUrl: { startsWith: "data:image/" } },
    select: { id: true, imageUrl: true },
    orderBy: { createdAt: "asc" },
    ...(limit ? { take: limit } : {}),
  });

  console.log(
    `[compress-avatars] ${dryRun ? "dry-run " : ""}candidates=${characters.length}${
      limit ? ` limit=${limit}` : ""
    }`
  );

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let savedBytes = 0;

  for (const character of characters) {
    const imageUrl = character.imageUrl;
    if (!imageUrl) {
      skipped += 1;
      continue;
    }

    const result = await tryCompressAvatarDataUrl(imageUrl);
    const savings =
      result.beforeBytes > 0
        ? ((1 - result.afterBytes / result.beforeBytes) * 100).toFixed(1)
        : "0.0";

    console.log(
      `[compress-avatars] ${character.id}  ${formatKb(result.beforeBytes)} KB -> ${formatKb(
        result.afterBytes
      )} KB  (${result.changed ? `-${savings}%` : "skip"})`
    );

    if (!result.changed) {
      skipped += 1;
      continue;
    }

    savedBytes += result.beforeBytes - result.afterBytes;
    if (dryRun) {
      updated += 1;
      continue;
    }

    try {
      await prisma.character.update({
        where: { id: character.id },
        data: { imageUrl: result.imageUrl },
      });
      updated += 1;
    } catch (error) {
      failed += 1;
      console.error(`[compress-avatars] failed to update ${character.id}`, error);
    }
  }

  console.log(
    `[compress-avatars] done updated=${updated} skipped=${skipped} failed=${failed} saved=${formatKb(
      savedBytes
    )} KB${dryRun ? " (dry-run, no writes)" : ""}`
  );
}

main()
  .catch((error) => {
    console.error("[compress-avatars] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
