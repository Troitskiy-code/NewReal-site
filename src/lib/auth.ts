import type { AuthOptions } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { activatePendingSubscriptionIfNeeded } from "./subscription";
import { translate } from "./getDictionary";
import { DEFAULT_LOCALE } from "./i18nConfig";

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

const prismaAdapter = PrismaAdapter(prisma);

export const authOptions: AuthOptions = {
  adapter: {
    ...prismaAdapter,
    async createUser(data) {
      console.log("[Auth] Adapter createUser:", data);
      try {
        const created = await prismaAdapter.createUser!(data);
        console.log("[Auth] Adapter createUser success:", created);
        return created;
      } catch (error) {
        console.error("[Auth] Adapter createUser failed:", error);
        throw error;
      }
    },
    async getUserByEmail(email) {
      const existing = await prismaAdapter.getUserByEmail!(email);
      console.log("[Auth] Adapter getUserByEmail:", { email, found: Boolean(existing), id: existing?.id });
      return existing;
    },
    async linkAccount(account) {
      console.log("[Auth] Adapter linkAccount:", {
        userId: account.userId,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
      });
      try {
        return await prismaAdapter.linkAccount!(account);
      } catch (error) {
        console.error("[Auth] Adapter linkAccount failed:", error);
        throw error;
      }
    },
  },
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error(translate(DEFAULT_LOCALE, "api.missingCredentials"));
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
          select: { id: true, email: true, name: true, password: true, createdAt: true },
        });

        if (!user || !user.password) {
          throw new Error(translate(DEFAULT_LOCALE, "api.userNotFound"));
        }

        const passwordMatch = await bcrypt.compare(credentials.password, user.password);
        if (!passwordMatch) {
          throw new Error(translate(DEFAULT_LOCALE, "api.wrongPassword"));
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
    async signIn({ user, account, profile }) {
      try {
        console.log("[Auth] Google signIn attempt:", {
          user,
          account: account
            ? {
                ...account,
                access_token: account.access_token ? "[redacted]" : undefined,
                refresh_token: account.refresh_token ? "[redacted]" : undefined,
                id_token: account.id_token ? "[redacted]" : undefined,
              }
            : account,
          profile,
        });
        return true;
      } catch (error) {
        console.error("[Auth] Error during signIn:", error);
        return false;
      }
    },
    async session({ session, token, user }) {
      if (session.user) {
        session.user.id = user?.id ?? token?.sub ?? token?.id ?? "";
        session.user.email = session.user.email ?? token.email ?? undefined;
        session.user.name = session.user.name ?? token.name ?? undefined;
        session.user.createdAt = token.createdAt ?? null;
        console.log("[Auth] Session created for user:", session.user.email, {
          id: session.user.id,
        });
      }
      await activatePendingForUserId(user?.id ?? token?.sub);
      return session;
    },
    async jwt({ token, user, account }) {
      if (user) {
        console.log("[Auth] JWT created for user:", {
          id: user.id,
          email: user.email,
          provider: account?.provider,
        });
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
  events: {
    async signIn({ user, account, isNewUser }) {
      console.log("[Auth] signIn event:", {
        id: user.id,
        email: user.email,
        provider: account?.provider,
        isNewUser,
      });
    },
    async createUser({ user }) {
      console.log("[Auth] createUser event:", {
        id: user.id,
        email: user.email,
        name: user.name,
      });
    },
    async linkAccount({ user, account }) {
      console.log("[Auth] linkAccount event:", {
        userId: user.id,
        email: user.email,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
      });
    },
  },
};
