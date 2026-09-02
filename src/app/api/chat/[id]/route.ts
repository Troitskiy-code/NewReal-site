import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { scheduleMessageEmbedding, shouldPersistEmbeddings } from "@/lib/messageEmbeddings";
import { analyzeIntent } from "@/lib/intentAnalyzer";
import { ingestUserMessageMemory } from "@/lib/advancedMemory";
import {
  buildChatResponsePayload,
  chargeForChatRequest,
  prepareChatMessages,
  resolveChatContext,
  isAssistantMessageCutOff,
  logActionOptionsIfPresent,
  mergeAssistantContinuation,
  streamChatCompletion,
} from "@/lib/chatHelpers";
import {
  consumeOpenAIChatStream,
  createChatNdjsonResponse,
} from "@/lib/chatStream";
import {
  calculateRequestCost,
  DAILY_REQUEST_LIMIT,
  isSubscriptionActive,
  normalizeUserCounters,
} from "@/lib/verseChatEconomy";

export const maxDuration = 120;

const KODIKROUTER_KEY = process.env.KODIKROUTER_API_KEY ?? "";

async function createMessageAndBumpTotal(data: {
  characterId: string;
  chatId: string;
  userId: string;
  role: string;
  content: string;
}) {
  const [message] = await prisma.$transaction([
    prisma.message.create({ data }),
    prisma.character.update({
      where: { id: data.characterId },
      data: { totalMessages: { increment: 1 } },
    }),
  ]);

  return message;
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

    const body = await req.json();
    const continueChat = body?.continue === true;
    const message = body?.message;

    if (!continueChat && (!message || typeof message !== "string")) {
      return NextResponse.json({ error: "Сообщение обязательно" }, { status: 400 });
    }

    const resolved = await resolveChatContext(session.user.id);
    if (!resolved) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    const { user, model, baseModel } = resolved;
    const now = new Date();
    const counters = normalizeUserCounters(user, now);
    const subscriptionActive = isSubscriptionActive(user);
    const persistEmbeddings = shouldPersistEmbeddings(user.subscriptionType, subscriptionActive);

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

    let greetingMessage = null;
    let userMessage = null;
    let lastAssistant = null;
    let ragQueryText: string | undefined;
    let excludeMessageId: string | undefined;
    let continueCutOff = false;
    let intent: Awaited<ReturnType<typeof analyzeIntent>>["intent"] = "general";

    if (continueChat) {
      lastAssistant = await prisma.message.findFirst({
        where: {
          characterId: id,
          userId: session.user.id,
          role: "assistant",
        },
        orderBy: { createdAt: "desc" },
      });

      if (!lastAssistant) {
        return NextResponse.json({ error: "Нет сообщения ассистента для продолжения" }, { status: 400 });
      }

      continueCutOff = isAssistantMessageCutOff(lastAssistant.content);
      console.log(`📌 Обрыв обнаружен: ${continueCutOff ? "да" : "нет"}`);
      if (continueCutOff) {
        console.log(`📌 Продолжение текста: ${lastAssistant.content.slice(-100)}...`);
      }
      ragQueryText = lastAssistant.content;
    } else {
      const existingMessagesCount = await prisma.message.count({
        where: { characterId: id, userId: session.user.id },
      });

      if (existingMessagesCount === 0 && character.greeting?.trim()) {
        greetingMessage = await createMessageAndBumpTotal({
          characterId: id,
          chatId: id,
          userId: session.user.id,
          role: "assistant",
          content: character.greeting.trim(),
        });

        scheduleMessageEmbedding(
          greetingMessage.id,
          greetingMessage.content,
          KODIKROUTER_KEY,
          persistEmbeddings
        );
      }

      userMessage = await createMessageAndBumpTotal({
        characterId: id,
        chatId: id,
        userId: session.user.id,
        role: "user",
        content: message,
      });

      scheduleMessageEmbedding(userMessage.id, message, KODIKROUTER_KEY, persistEmbeddings);
      ragQueryText = message;
      excludeMessageId = userMessage.id;

      const analysis = await analyzeIntent(message, KODIKROUTER_KEY);
      intent = analysis.intent;

      await ingestUserMessageMemory({
        userId: session.user.id,
        characterId: id,
        userMessage: message,
        intent,
        apiKey: KODIKROUTER_KEY,
      });
    }

    const { messages: trimmedMessages } = await prepareChatMessages({
      userId: session.user.id,
      characterId: id,
      character,
      user,
      model,
      apiKey: KODIKROUTER_KEY,
      ragQueryText,
      excludeMessageId,
      continueMode: continueChat,
      continueCutOff,
      continueSourceText: lastAssistant?.content,
      intent,
    });

    return createChatNdjsonResponse(async (emit) => {
      emit({
        type: "meta",
        greetingMessage: greetingMessage ?? undefined,
        userMessage: userMessage ?? undefined,
        appendToId:
          continueChat && continueCutOff && lastAssistant ? lastAssistant.id : undefined,
      });

      const upstream = await streamChatCompletion(model.name, trimmedMessages, KODIKROUTER_KEY);
      const assistantReply = await consumeOpenAIChatStream(upstream, (text) => {
        emit({ type: "delta", text });
      });

      logActionOptionsIfPresent(assistantReply);

      const charge = await chargeForChatRequest({
        userId: session.user.id,
        costVC,
        counters,
        characterName: character.name,
        modelDisplayName: model.displayName,
      });

      const assistantMessage =
        continueChat && continueCutOff && lastAssistant
          ? await prisma.message.update({
              where: { id: lastAssistant.id },
              data: {
                content: mergeAssistantContinuation(lastAssistant.content, assistantReply),
              },
            })
          : await createMessageAndBumpTotal({
              characterId: id,
              chatId: id,
              userId: session.user.id,
              role: "assistant",
              content: assistantReply,
            });

      scheduleMessageEmbedding(
        assistantMessage.id,
        assistantMessage.content,
        KODIKROUTER_KEY,
        persistEmbeddings
      );

      emit({
        type: "end",
        ...buildChatResponsePayload({
          costVC,
          remainingVC: charge.remainingVC,
          nextDailyRequests: charge.nextDailyRequests,
          limitWarning: charge.limitWarning,
          model,
          greetingMessage: greetingMessage ?? undefined,
          userMessage: userMessage ?? undefined,
          assistantMessage,
        }),
      });
    });
  } catch (error) {
    console.error("Chat error:", error);
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
      select: { isPublic: true, userId: true, name: true, greeting: true, imageUrl: true, description: true },
    });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    if (!character.isPublic && character.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    const messages = await prisma.message.findMany({
      where: { characterId: id, userId: session.user.id },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({
      messages,
      character: {
        name: character.name,
        greeting: character.greeting,
        imageUrl: character.imageUrl,
        description: character.description,
      },
    });
  } catch (error) {
    console.error("Get history error:", error);
    return NextResponse.json({ error: "Ошибка получения истории" }, { status: 500 });
  }
}
