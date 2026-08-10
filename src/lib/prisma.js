import { PrismaClient } from '@prisma/client';

const FALLBACK_URL = "postgresql://postgres:Timofey18012005%21@localhost:5432/ai_characters";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL || FALLBACK_URL,
});

export { prisma };