import { PrismaClient } from '@prisma/client';
import { getRequiredEnv } from './requireEnv';
import { reportPrismaFailure } from './safeDiagnostics';

const globalForPrisma = globalThis;

const createdNewClient = !globalForPrisma.prismaBase;

const basePrisma =
  globalForPrisma.prismaBase ||
  new PrismaClient({
    datasourceUrl: getRequiredEnv("DATABASE_URL"),
    log: [],
  });

const prisma =
  globalForPrisma.prisma ||
  basePrisma.$extends({
  query: {
    character: {
      async update({ args, query }) {
        // Invalidate translations in the same write as a source edit, including admin edits.
        // Updating counters, slugs or English compatibility fields leaves them intact.
        const sourceFields = ["name", "description", "descriptionCard", "appearance", "greeting", "scenario", "exampleDialogs", "avatarPrompt", "publicMemory"];
        if (sourceFields.some((field) => args.data[field] !== undefined)) {
          args.data.translations = { ...args.data.translations, deleteMany: {} };
        } else if (sourceFields.some((field) => args.data[`${field}_en`] !== undefined)) {
          args.data.translations = { ...args.data.translations, deleteMany: { locale: "en" } };
        }
        return query(args);
      },
    },
    user: {
      async create({ args, query }) {
        console.log('[Prisma] User create attempt');
        try {
          const result = await query(args);
          console.log('[Prisma] User created successfully:', { id: result?.id });
          return result;
        } catch (error) {
          reportPrismaFailure("User.create", error);
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
          reportPrismaFailure("Account.create", error);
          throw error;
        }
      },
    },
  },
});

// Always keep the singleton on globalThis, including production.
// Next.js / Turbopack can evaluate this module in more than one chunk.
globalForPrisma.prismaBase = basePrisma;
globalForPrisma.prisma = prisma;

if (
  createdNewClient &&
  (!process.env['NEXT_PHASE'] || process.env['NEXT_PHASE'] !== "phase-production-build")
) {
  console.log("[prisma] singleton initialized (pid:", process.pid, ")");
  console.log(
    "[prisma] config: connection_limit =",
    process.env.DATABASE_URL?.match(/connection_limit=(\d+)/)?.[1] ?? "default"
  );
}

export { prisma };
