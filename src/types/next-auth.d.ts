import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    createdAt?: Date | string | null;
  }

  interface Session {
    user: {
      id: string;
      createdAt?: string | null; // добавляем
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    createdAt?: string | null; // добавляем
  }
}