import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";
import { reportAuthFailure } from "@/lib/safeDiagnostics";

const nextAuthHandler = NextAuth(authOptions);

async function handler(...args: Parameters<typeof nextAuthHandler>) {
  try {
    return await nextAuthHandler(...args);
  } catch (error) {
    reportAuthFailure("route.handler", error);
    throw error;
  }
}

export { handler as GET, handler as POST };
