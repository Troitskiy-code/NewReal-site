import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

const nextAuthHandler = NextAuth(authOptions);

async function handler(...args: Parameters<typeof nextAuthHandler>) {
  try {
    return await nextAuthHandler(...args);
  } catch (error) {
    console.error("[Auth] Error during signIn:", error);
    throw error;
  }
}

export { handler as GET, handler as POST };
