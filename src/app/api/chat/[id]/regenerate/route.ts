import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import axios from "axios";
import {
  buildChatResponsePayload,
  callChatCompletion,
  chargeForChatRequest,
  logActionOptionsIfPresent,
  prepareChatMessages,
  resolveChatContext,
} from "@/lib/chatHelpers";
import {
  calculateRequestCost,
  DAILY_REQUEST_LIMIT,
  normalizeUserCounters,
} from "@/lib/verseChatEconomy";

const KODIKROUTER_KEY = process.env.KODIKROUTER_API_KEY ?? "";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    if (!KODIKROUTER_KEY) {
      return NextResponse.json({ error: "KODIKROUTER_API_KEY не настроен" }, { status: 500 });
    }

    const { id: characterId } = await params;
    const { messageId } = await req.json();

    if (!messageId || typeof messageId !== "string") {
      return NextResponse.json({ error: "messageId обязателен" }, { status: 400 });
    }

    const assistantMessage = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        role: true,
        content: true,
        createdAt: true,
        characterId: true,
        userId: true,
      },
    });

    if (!assistantMessage) {
      return NextResponse.json({ error: "Сообщение не найдено" }, { status: 404 });
    }

    if (assistantMessage.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    if (assistantMessage.characterId !== characterId) {
      return NextResponse.json({ error: "Сообщение не относится к этому чату" }, { status: 400 });
    }

    if (assistantMessage.role !== "assistant") {
      return NextResponse.json({ error: "Можно перегенерировать только ответ ассистента" }, { status: 400 });
    }

    const character = await prisma.character.findUnique({
      where: { id: characterId },
      select: {
        id: true,
        name: true,
        description: true,
        appearance: true,
        greeting: true,
        scenario: true,
        exampleDialogs: true,
        isPublic: true,
        userId: true,
      },
    });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    const resolved = await resolveChatContext(session.user.id);
    if (!resolved) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    const { user, model, baseModel } = resolved;
    const now = new Date();
    const counters = normalizeUserCounters(user, now);

    if (counters.dailyRequests >= DAILY_REQUEST_LIMIT) {
      return NextResponse.json(
        {
          error: "Достигнут суточный лимит запросов",
          dailyRequests: counters.dailyRequests,
          dailyLimit: DAILY_REQUEST_LIMIT,
        },
        { status: 429 }
      );
    }

    const costResult = calculateRequestCost(user, model, baseModel);
    if (costResult.ok === false) {
      return NextResponse.json(
        {
          error: costResult.error || "Недостаточно средств",
          ...costResult.details,
        },
        { status: costResult.status || 402 }
      );
    }

    const { costVC } = costResult;

    if (costVC > 0 && user.verseCoins < costVC) {
      return NextResponse.json(
        {
          error: "Недостаточно VerseCoins",
          requiredVC: costVC,
          balance: user.verseCoins,
        },
        { status: 402 }
      );
    }

    const previousUserMessage = await prisma.message.findFirst({
      where: {
        characterId,
        userId: session.user.id,
        role: "user",
        createdAt: { lt: assistantMessage.createdAt },
      },
      orderBy: { createdAt: "desc" },
    });

    const { messages: trimmedMessages } = await prepareChatMessages({
      userId: session.user.id,
      characterId,
      character,
      user,
      model,
      apiKey: KODIKROUTER_KEY,
      ragQueryText: previousUserMessage?.content ?? assistantMessage.content,
      historyBeforeMessageId: assistantMessage.id,
    });

    const assistantReply = await callChatCompletion(model.name, trimmedMessages, KODIKROUTER_KEY);
    logActionOptionsIfPresent(assistantReply);

    const charge = await chargeForChatRequest({
      userId: session.user.id,
      costVC,
      counters,
      characterName: character.name,
      modelDisplayName: model.displayName,
    });

    const updatedMessage = await prisma.message.update({
      where: { id: assistantMessage.id },
      data: {
        content: assistantReply,
        createdAt: new Date(),
      },
    });

    return NextResponse.json(
      buildChatResponsePayload({
        costVC,
        remainingVC: charge.remainingVC,
        nextDailyRequests: charge.nextDailyRequests,
        limitWarning: charge.limitWarning,
        model,
        assistantMessage: updatedMessage,
      })
    );
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("Regenerate error:", error.response?.status, error.response?.data ?? error.message);
    } else {
      console.error("Regenerate error:", error);
    }
    return NextResponse.json({ error: "Ошибка при перегенерации ответа" }, { status: 500 });
  }
}
