import { PrismaClient } from '@prisma/client';

const FALLBACK_URL = "postgresql://postgres:Timofey18012005%21@localhost:5432/ai_characters";

const basePrisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL || FALLBACK_URL,
});

let slugColumnPromise = null;
let notificationTablePromise = null;

function ensureSlugColumnSql() {
  if (!slugColumnPromise) {
    slugColumnPromise = (async () => {
      await basePrisma.$executeRawUnsafe(`ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "slug" TEXT`);
      await basePrisma.$executeRawUnsafe(`UPDATE "Character" SET "slug" = 'c-' || "id" WHERE "slug" IS NULL`);
      await basePrisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "Character_slug_key" ON "Character"("slug")`
      );
      console.log("[Prisma] Character.slug column is ready");
    })().catch((error) => {
      slugColumnPromise = null;
      console.error("[Prisma] Failed to ensure Character.slug", error);
      throw error;
    });
  }
  return slugColumnPromise;
}

function ensureNotificationTableSql() {
  if (!notificationTablePromise) {
    notificationTablePromise = (async () => {
      await basePrisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "Notification" (
          "id" TEXT NOT NULL,
          "userId" TEXT NOT NULL,
          "type" TEXT NOT NULL,
          "title" TEXT NOT NULL,
          "message" TEXT NOT NULL,
          "link" TEXT,
          "read" BOOLEAN NOT NULL DEFAULT false,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
        )
      `);
      await basePrisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "Notification_userId_read_idx" ON "Notification"("userId", "read")`
      );
      await basePrisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt")`
      );
      await basePrisma.$executeRawUnsafe(`
        DO $$ BEGIN
          ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;
      `);
      console.log("[Prisma] Notification table is ready");
    })().catch((error) => {
      notificationTablePromise = null;
      console.error("[Prisma] Failed to ensure Notification table", error);
      throw error;
    });
  }
  return notificationTablePromise;
}

const prisma = basePrisma.$extends({
  query: {
    notification: {
      async $allOperations({ args, query }) {
        try {
          await ensureNotificationTableSql();
        } catch (error) {
          console.error("[Prisma] Notification table ensure skipped", error);
        }
        return query(args);
      },
    },
    character: {
      async $allOperations({ args, query }) {
        try {
          await ensureSlugColumnSql();
        } catch (error) {
          console.error("[Prisma] Character.slug ensure skipped", error);
        }
        return query(args);
      },
    },
    user: {
      async create({ args, query }) {
        console.log('[Prisma] User create attempt:', args);
        try {
          const result = await query(args);
          console.log('[Prisma] User created successfully:', result);
          return result;
        } catch (error) {
          console.error('[Prisma] User create failed:', error);
          throw error;
        }
      },
    },
    account: {
      async create({ args, query }) {
        console.log('[Prisma] Account create attempt:', {
          provider: args.data?.provider,
          userId: args.data?.userId,
          providerAccountId: args.data?.providerAccountId,
        });
        try {
          const result = await query(args);
          console.log('[Prisma] Account created successfully:', {
            id: result?.id,
            userId: result?.userId,
            provider: result?.provider,
          });
          return result;
        } catch (error) {
          console.error('[Prisma] Account create failed:', error);
          throw error;
        }
      },
    },
  },
});

export { prisma };
