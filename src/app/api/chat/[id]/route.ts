import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import axios from "axios";
import {
  calculateCostRubles,
  estimateTokensFromText,
  isModelFreeForUser,
  rublesToRealCoins,
} from "@/lib/chatEconomy";
import { buildChatSystemPrompt } from "@/lib/chatSystemPrompt";
console.log("🔑 ENV KODIKROUTER_API_KEY:", process.env.KODIKROUTER_API_KEY ? "ЕСТЬ" : "НЕТ");
const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const KODIKROUTER_KEY = "sk-kr_live_6rzN8Y-SX7Y-jUY__zfjuRqxYBvfHJ42";
const MAX_OUTPUT_TOKENS = 500;

async function resolveUserModel(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      realCoins: true,
      isSubscribed: true,
      selectedModel: true,
    },
  });

  if (!user) return null;

  let model = user.selectedModel;
  if (!model || !model.isActive) {
    model = await prisma.model.findFirst({
      where: { isActive: true },
      orderBy: { pricePer1MInput: "asc" },
    });
  }

  if (!model) {
    // Создаём модель по умолчанию, если её нет в базе
    model = await prisma.model.create({
      data: {
        name: "gpt-4o-mini",
        displayName: "GPT-4o Mini",
        pricePer1MInput: 1.5,
        pricePer1MOutput: 6,
        isFreeForSubscribers: true,
        isActive: true,
      },
    });
  }

  return { user, model };
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

    const resolved = await resolveUserModel(session.user.id);
    if (!resolved?.model) {
      return NextResponse.json({ error: "Нет доступных моделей" }, { status: 500 });
    }

    const { user, model } = resolved;
    const isFree = isModelFreeForUser(model, user.isSubscribed);

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
      isFree,
    });

    const inputText = [
      systemPrompt,
      ...history.map((msg) => msg.content),
      message,
    ].join("\n");

    const inputTokens = estimateTokensFromText(inputText);

    if (!isFree) {
      const estimatedCostRubles = calculateCostRubles(inputTokens, MAX_OUTPUT_TOKENS, model);
      const estimatedCostCoins = rublesToRealCoins(estimatedCostRubles);

      if (user.realCoins < estimatedCostCoins) {
        return NextResponse.json(
          {
            error: "Недостаточно средств",
            requiredCoins: estimatedCostCoins,
            balance: user.realCoins,
          },
          { status: 402 }
        );
      }
    }

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
        model: "gpt-4-turbo",
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

    const outputTokens = estimateTokensFromText(assistantReply);
    let chargedCoins = 0;
    let remainingCoins = user.realCoins;

    if (!isFree) {
      const actualCostRubles = calculateCostRubles(inputTokens, outputTokens, model);
      chargedCoins = rublesToRealCoins(actualCostRubles);

      console.log("[chat] charging user", {
        userId: session.user.id,
        chargedCoins,
        inputTokens,
        outputTokens,
      });

      const updatedUser = await prisma.user.update({
        where: { id: session.user.id },
        data: { realCoins: { decrement: chargedCoins } },
        select: { realCoins: true },
      });
      remainingCoins = updatedUser.realCoins;
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

    return NextResponse.json({
      userMessage,
      assistantMessage,
      model: {
        id: model.id,
        displayName: model.displayName,
      },
      chargedCoins,
      remainingCoins,
      isFree,
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
      select: { isPublic: true, userId: true, name: true, greeting: true },
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
      },
    });
  } catch (error) {
    console.error("Get history error:", error);
    return NextResponse.json({ error: "Ошибка получения истории" }, { status: 500 });
  }
}
