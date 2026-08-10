import { PrismaAdapter } from "@auth/prisma-adapter";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";

console.log("🔑 NEXTAUTH_SECRET from env:", process.env.NEXTAUTH_SECRET);

export const authOptions = {
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
  ],
  session: { strategy: "jwt" as const },
  secret: "a7f9e2c1b5d8e4f6a9c2d3e1f5b8a7c9d4e2f6a3b8c9d1e5f7a2b6c4d8e9f0a1",
  callbacks: {
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.sub;
        session.user.email = token.email;
        session.user.name = token.name;
        session.user.createdAt = token.createdAt;
      }
      return session;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.email = user.email;
        token.name = user.name;
        token.createdAt = user.createdAt;
      }
      return token;
    },
  },
};