import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import axios from "axios";
import { buildChatSystemPrompt } from "@/lib/chatSystemPrompt";
import {
  calculateRequestCost,
  DAILY_REQUEST_LIMIT,
  FREE_TIER_MONTHLY_LIMIT,
  getDailyLimitWarning,
  normalizeUserCounters,
  type EconomyModel,
} from "@/lib/verseChatEconomy";

console.log("🔑 ENV KODIKROUTER_API_KEY:", process.env.KODIKROUTER_API_KEY ? "ЕСТЬ" : "НЕТ");
const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const KODIKROUTER_KEY = "sk-kr_live_6rzN8Y-SX7Y-jUY__zfjuRqxYBvfHJ42";
const MAX_OUTPUT_TOKENS = 1500;

const modelSelect = {
  id: true,
  name: true,
  displayName: true,
  priceVC: true,
  isFreeForSubscribers: true,
  isActive: true,
} as const;

async function getOrCreateBaseModel(): Promise<EconomyModel> {
  let baseModel = await prisma.model.findFirst({
    where: { isActive: true },
    orderBy: { priceVC: "asc" },
    select: modelSelect,
  });

  if (!baseModel) {
    baseModel = await prisma.model.create({
      data: {
        name: "gpt-4o-mini",
        displayName: "GPT-4o Mini",
        pricePer1MInput: 1.5,
        pricePer1MOutput: 6,
        priceVC: 0,
        isFreeForSubscribers: true,
        isActive: true,
      },
      select: modelSelect,
    });
  }

  return baseModel;
}

async function resolveChatContext(userId: string) {
  const baseModel = await getOrCreateBaseModel();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      verseCoins: true,
      subscriptionType: true,
      subscriptionEnd: true,
      freeRequestsUsed: true,
      freeRequestsMonth: true,
      dailyRequests: true,
      dailyRequestsDate: true,
      selectedModel: { select: modelSelect },
    },
  });

  if (!user) return null;

  let model = user.selectedModel;
  if (!model || !model.isActive) {
    model = baseModel;
  }

  return { user, model, baseModel };
}

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

    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "ID персонажа не указан" }, { status: 400 });
    }

    console.log("[chat] POST start", { characterId: id, userId: session.user.id });

    const character = await prisma.character.findUnique({
      where: { id },
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

    if (!character.isPublic && character.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    const { message } = await req.json();
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Сообщение обязательно" }, { status: 400 });
    }

    console.log("[chat] message received", {
      characterId: id,
      userId: session.user.id,
      messageLength: message.length,
    });

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

    const costResult = calculateRequestCost(user, model, baseModel, counters);
    if (costResult.ok === false) {
      return NextResponse.json(
        {
          error: costResult.error || "Недостаточно средств",
          ...costResult.details,
        },
        { status: costResult.status || 402 }
      );
    }

    const { costVC, usesFreeTier } = costResult;

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

    const systemPrompt = buildChatSystemPrompt(character);

    const history = await prisma.message.findMany({
      where: { characterId: id },
      orderBy: { createdAt: "asc" },
      take: 10,
    });

    console.log("[chat] context prepared", {
      characterId: id,
      characterName: character.name,
      model: model.name,
      historyCount: history.length,
      costVC,
      usesFreeTier,
    });

    console.log("[chat] saving user message", { characterId: id, userId: session.user.id });

    const userMessage = await prisma.message.create({
      data: {
        characterId: id,
        chatId: id,
        userId: session.user.id,
        role: "user",
        content: message,
      },
    });

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.map((msg) => ({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content,
      })),
      { role: "user", content: message },
    ];

    console.log("[chat] KodikRouter request", {
      characterId: id,
      model: model.name,
      messagesCount: messages.length,
      maxTokens: MAX_OUTPUT_TOKENS,
    });

    const response = await axios.post(
      `${KODIKROUTER_URL}/chat/completions`,
      {
        model: "openai/gpt-4-turbo",
        messages,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.8,
      },
      {
        headers: {
          Authorization: `Bearer ${KODIKROUTER_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const assistantReply = response.data.choices[0]?.message?.content?.trim();
    if (!assistantReply) {
      throw new Error("Пустой ответ от ИИ");
    }

    const nextDailyRequests = counters.dailyRequests + 1;
    const nextFreeRequestsUsed = usesFreeTier
      ? counters.freeRequestsUsed + 1
      : counters.freeRequestsUsed;

    console.log("[chat] charging user", {
      userId: session.user.id,
      chargedVC: costVC,
      usesFreeTier,
      nextDailyRequests,
      nextFreeRequestsUsed,
    });

    const updatedUser = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        verseCoins: costVC > 0 ? { decrement: costVC } : undefined,
        dailyRequests: nextDailyRequests,
        dailyRequestsDate: counters.dailyRequestsDate,
        freeRequestsUsed: nextFreeRequestsUsed,
        freeRequestsMonth: counters.freeRequestsMonth,
      },
      select: { verseCoins: true },
    });

    if (costVC > 0) {
      await prisma.transaction.create({
        data: {
          userId: session.user.id,
          amount: -costVC,
          type: "chat",
          description: `Чат: ${character.name}, модель ${model.displayName}`,
        },
      });
    }

    console.log("[chat] saving assistant message", {
      characterId: id,
      userId: session.user.id,
      replyLength: assistantReply.length,
    });

    const assistantMessage = await prisma.message.create({
      data: {
        characterId: id,
        chatId: id,
        userId: session.user.id,
        role: "assistant",
        content: assistantReply,
      },
    });

    const limitWarning = getDailyLimitWarning(nextDailyRequests);

    return NextResponse.json({
      userMessage,
      assistantMessage,
      model: {
        id: model.id,
        displayName: model.displayName,
      },
      chargedVC: costVC,
      remainingVC: updatedUser.verseCoins,
      isFree: costVC === 0,
      freeRequestsUsed: nextFreeRequestsUsed,
      freeRequestsRemaining: Math.max(0, FREE_TIER_MONTHLY_LIMIT - nextFreeRequestsUsed),
      dailyRequests: nextDailyRequests,
      dailyLimit: DAILY_REQUEST_LIMIT,
      limitWarning,
      chargedCoins: costVC,
      remainingCoins: updatedUser.verseCoins,
    });
  } catch (error) {
    console.error("Chat error:", error);
    console.log("Подробная ошибка:", JSON.stringify(error, null, 2));
    console.error("Chat error details:", {
      message: (error as Error).message,
      stack: (error as Error).stack,
      response: axios.isAxiosError(error) ? error.response?.data : undefined,
      status: axios.isAxiosError(error) ? error.response?.status : undefined,
    });
    return NextResponse.json({ error: "Ошибка при обработке запроса" }, { status: 500 });
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "ID персонажа не указан" }, { status: 400 });
    }

    const character = await prisma.character.findUnique({
      where: { id },
      select: { isPublic: true, userId: true, name: true, greeting: true, imageUrl: true },
    });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    if (!character.isPublic && character.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    const messages = await prisma.message.findMany({
      where: { characterId: id },
      orderBy: { createdAt: "asc" },
      take: 50,
    });

    return NextResponse.json({
      messages,
      character: {
        name: character.name,
        greeting: character.greeting,
        imageUrl: character.imageUrl,
      },
    });
  } catch (error) {
    console.error("Get history error:", error);
    return NextResponse.json({ error: "Ошибка получения истории" }, { status: 500 });
  }
}
