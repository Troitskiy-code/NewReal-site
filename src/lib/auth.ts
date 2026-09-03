import type { AuthOptions } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { activatePendingSubscriptionIfNeeded } from "./subscription";

export function isGoogleAuthEnabled(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
      process.env.GOOGLE_CLIENT_SECRET?.trim()
  );
}

async function activatePendingForUserId(userId?: string | null) {
  if (!userId) return;
  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        subscriptionType: true,
        subscriptionEnd: true,
        pendingSubscriptionType: true,
        pendingSubscriptionEnd: true,
      },
    });
    if (dbUser) {
      await activatePendingSubscriptionIfNeeded(dbUser);
    }
  } catch (error) {
    console.error("[Auth] Pending subscription activation failed:", error);
  }
}

export const authOptions: AuthOptions = {
  adapter: PrismaAdapter(prisma),
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error("Не указаны email или пароль");
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
          select: { id: true, email: true, name: true, password: true, createdAt: true },
        });

        if (!user || !user.password) {
          throw new Error("Пользователь не найден");
        }

        const passwordMatch = await bcrypt.compare(credentials.password, user.password);
        if (!passwordMatch) {
          throw new Error("Неверный пароль");
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          createdAt: user.createdAt,
        };
      },
    }),
    ...(isGoogleAuthEnabled()
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          }),
        ]
      : []),
  ],
  session: {
    strategy: "jwt" as const,
  },
  secret: "a7f9e2c1b5d8e4f6a9c2d3e1f5b8a7c9d4e2f6a3b8c9d1e5f7a2b6c4d8e9f0a1",
  callbacks: {
    async session({ session, token, user }) {
      if (session.user) {
        session.user.id = user?.id ?? token?.sub ?? token?.id ?? "";
        session.user.email = session.user.email ?? token.email ?? undefined;
        session.user.name = session.user.name ?? token.name ?? undefined;
        session.user.createdAt = token.createdAt ?? null;
      }
      await activatePendingForUserId(user?.id ?? token?.sub);
      return session;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.email = user.email;
        token.name = user.name;
        token.createdAt =
          user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt ?? null;
        await activatePendingForUserId(user.id);
      }
      return token;
    },
  },
};
