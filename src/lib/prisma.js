import { PrismaClient } from '@prisma/client';

const FALLBACK_URL = "postgresql://postgres:Timofey18012005%21@localhost:5432/ai_characters";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL || FALLBACK_URL,
}).$extends({
  query: {
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
