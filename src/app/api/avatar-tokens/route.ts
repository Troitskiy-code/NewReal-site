import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAvatarTokenStatus, replenishAvatarTokens } from "@/lib/avatarTokens";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const user = await replenishAvatarTokens(session.user.id);
    return NextResponse.json(getAvatarTokenStatus(user));
  } catch (error) {
    console.error("Avatar tokens fetch error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
