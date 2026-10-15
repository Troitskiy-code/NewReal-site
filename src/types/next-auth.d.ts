import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    createdAt?: Date | string | null;
    emailVerified?: Date | string | null;
  }

  interface Session {
    user: {
      id: string;
      oauthLoginEventId?: string;
      oauthRegistrationUserId?: string;
      createdAt?: string | null;
      emailVerified?: Date | string | null;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    oauthLoginEventId?: string;
    oauthRegistrationUserId?: string;
    oauthRegistrationAt?: number;
    createdAt?: string | null;
    emailVerified?: Date | string | boolean | null;
    emailVerifiedChecked?: number;
    /** TelegramAccount id of a session issued by a Mini App launch; revoked by unlinking. */
    telegramAccountId?: string;
  }
}
