import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAuthorizedChatScope } from "@/lib/chatAccess";
import { emptyChatMemoryPayload, getChatMemoryPayload } from "@/lib/advancedMemory";
import { requestedThreadId } from "@/lib/chatThreads";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id: characterId } = await params;
    if (!characterId) {
      return NextResponse.json({ error: "ID персонажа не указан" }, { status: 400 });
    }

    const access = await getAuthorizedChatScope(session.user.id, characterId, requestedThreadId(req));
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const isOwner = access.character.userId === session.user.id;
    const includeLowImportance = isOwner && req.nextUrl.searchParams.get("all") === "1";
    const payload = access.resolution.status === "found"
      ? await getChatMemoryPayload(access.resolution.scope, { includeLowImportance })
      : emptyChatMemoryPayload(includeLowImportance);
    console.log(
      `[MemoryEditor] loaded character=${characterId} summary=${payload.summary ? "yes" : "no"} core=${payload.core ? "yes" : "no"} episodic=${payload.episodic.length} all=${includeLowImportance}`
    );
    return NextResponse.json({ ...payload, isOwner });
  } catch (error) {
    errorLog("Server", "[MemoryEditor] Get chat memory error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось загрузить память" }, { status: 500 });
  }
}
