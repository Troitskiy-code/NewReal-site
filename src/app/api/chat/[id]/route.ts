import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensureCharacterSlugColumn, isMissingSlugColumn } from "@/lib/ensureCharacterSlug";
import { scheduleMessageEmbedding, shouldPersistEmbeddings } from "@/lib/messageEmbeddings";
import { analyzeIntent } from "@/lib/intentAnalyzer";
import { ingestUserMessageMemory } from "@/lib/advancedMemory";
import { resolveChatMemorySummary } from "@/lib/chatMemory";
import {
  assemblePreparedChatMessages,
  buildChatResponsePayload,
  chargeForChatRequest,
  isAssistantMessageCutOff,
  logActionOptionsIfPresent,
  mergeAssistantContinuation,
  prepareFastContext,
  resolveChatContext,
  searchRagContext,
  shouldWaitForRag,
  streamChatCompletion,
} from "@/lib/chatHelpers";
import {
  consumeOpenAIChatStream,
  createChatNdjsonResponse,
} from "@/lib/chatStream";
import {
  calculateRequestCost,
  isSubscriptionActive,
} from "@/lib/verseChatEconomy";
import { getApiLocale } from "@/lib/apiI18n";
import { getAnonymousChatPayload, handleAnonymousChatPost } from "@/lib/anonymousChat";
import { runWithLogUser } from "@/lib/logger";

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
      data: { totalMessages: { increment: 1 }, lastActive: new Date() },
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
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "ID персонажа не указан" }, { status: 400 });
    }

    if (!KODIKROUTER_KEY) {
      return NextResponse.json({ error: "KODIKROUTER_API_KEY не настроен" }, { status: 500 });
    }

    if (!session?.user?.id) {
      const body = await req.json().catch(() => ({}));
      return handleAnonymousChatPost(req, id, body);
    }

    return await runWithLogUser(session.user.id, async () => {
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
        name_en: true,
        description_en: true,
        appearance_en: true,
        greeting_en: true,
        scenario_en: true,
        exampleDialogs_en: true,
        systemPrompt: true,
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
    const subscriptionActive = isSubscriptionActive(user);
    const persistEmbeddings = shouldPersistEmbeddings(user.subscriptionType, subscriptionActive);

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

    const locale = getApiLocale(req);
    const localizedGreeting =
      locale === "en" && character.greeting_en?.trim()
        ? character.greeting_en.trim()
        : character.greeting?.trim();
    let greetingMessage = null;
    let userMessage = null;
    let lastAssistant = null;
    let ragQueryText: string | undefined;
    let excludeMessageId: string | undefined;
    let continueCutOff = false;

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

      if (existingMessagesCount === 0 && localizedGreeting) {
        greetingMessage = await createMessageAndBumpTotal({
          characterId: id,
          chatId: id,
          userId: session.user.id,
          role: "assistant",
          content: localizedGreeting,
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
    }

    const ttftStartedAt = Date.now();
    const prepareOptions = {
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
      locale,
      refreshSummary: false,
    };

    const [fastContext, analysis] = await Promise.all([
      (async () => {
        const started = Date.now();
        try {
          const context = await prepareFastContext({ ...prepareOptions, intent: "general" });
          console.log(`[ChatTTFT] Fast context prepared in ${Date.now() - started}ms`);
          return context;
        } catch (error) {
          console.error("[ChatTTFT] Fast context failed", error);
          throw error;
        }
      })(),
      (async () => {
        if (continueChat || typeof message !== "string") {
          console.log("[ChatTTFT] Intent analysis: general, 0ms");
          return { intent: "general" as const, confidence: 0 };
        }
        const started = Date.now();
        try {
          const result = await analyzeIntent(message, KODIKROUTER_KEY);
          console.log(`[ChatTTFT] Intent analysis: ${result.intent}, ${Date.now() - started}ms`);
          return result;
        } catch (error) {
          console.error("[ChatTTFT] Intent analysis failed, fallback general", error);
          console.log(`[ChatTTFT] Intent analysis: general, ${Date.now() - started}ms`);
          return { intent: "general" as const, confidence: 0 };
        }
      })(),
    ]);

    const intent = analysis.intent;
    const waitForRag = shouldWaitForRag(intent);
    console.log(`[ChatTTFT] Waiting for RAG: ${waitForRag}`);

    let ragContextText: string | null = null;
    if (waitForRag) {
      try {
        ragContextText = await searchRagContext({
          userId: session.user.id,
          characterId: id,
          apiKey: KODIKROUTER_KEY,
          ragQueryText,
          excludeMessageId,
          intent,
          ragEligible: fastContext.ragEligible,
          totalHistoryTokens: fastContext.totalHistoryTokens,
        });
      } catch (error) {
        console.error("[ChatTTFT] RAG failed, continuing without it", error);
      }
    }

    const { messages: trimmedMessages } = assemblePreparedChatMessages(
      fastContext,
      intent,
      ragContextText
    );

    if (!continueChat && typeof message === "string") {
      void ingestUserMessageMemory({
        userId: session.user.id,
        characterId: id,
        userMessage: message,
        intent,
        apiKey: KODIKROUTER_KEY,
      }).catch((error) => {
        console.error("[ChatTTFT] background memory ingest failed", error);
      });
      void resolveChatMemorySummary(session.user.id, id, KODIKROUTER_KEY, user).catch((error) => {
        console.error("[ChatTTFT] background summary refresh failed", error);
      });
    }

    return createChatNdjsonResponse(async (emit) => {
      emit({
        type: "meta",
        greetingMessage: greetingMessage ?? undefined,
        userMessage: userMessage ?? undefined,
        appendToId:
          continueChat && continueCutOff && lastAssistant ? lastAssistant.id : undefined,
      });

      const upstream = await streamChatCompletion(model.name, trimmedMessages, KODIKROUTER_KEY);
      let loggedTtft = false;
      const assistantReply = await consumeOpenAIChatStream(upstream, (text) => {
        if (!loggedTtft) {
          loggedTtft = true;
          console.log(`[ChatTTFT] Total TTFT: ${Date.now() - ttftStartedAt}ms`);
        }
        emit({ type: "delta", text });
      });
      if (!loggedTtft) {
        console.log(`[ChatTTFT] Total TTFT: ${Date.now() - ttftStartedAt}ms`);
      }

      logActionOptionsIfPresent(assistantReply);

      const charge = await chargeForChatRequest({
        userId: session.user.id,
        costVC,
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
          model,
          greetingMessage: greetingMessage ?? undefined,
          userMessage: userMessage ?? undefined,
          assistantMessage,
        }),
      });
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
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "ID персонажа не указан" }, { status: 400 });
    }

    if (!session?.user?.id) {
      return getAnonymousChatPayload(req, id);
    }

    try {
      await ensureCharacterSlugColumn();
    } catch (error) {
      console.error("[chat] Could not ensure slug column", error);
    }

    const characterSelectNoSlug = {
      isPublic: true,
      userId: true,
      name: true,
      greeting: true,
      imageUrl: true,
      description: true,
      descriptionCard: true,
      descriptionCard_en: true,
      name_en: true,
      greeting_en: true,
      description_en: true,
    } as const;

    let character;
    try {
      character = await prisma.character.findUnique({
        where: { id },
        select: { ...characterSelectNoSlug, slug: true },
      });
    } catch (error) {
      if (!isMissingSlugColumn(error)) throw error;
      character = await prisma.character.findUnique({
        where: { id },
        select: characterSelectNoSlug,
      });
    }

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
        slug: "slug" in character ? character.slug : null,
        greeting: character.greeting,
        imageUrl: character.imageUrl,
        description: character.description,
        descriptionCard: character.descriptionCard,
        descriptionCard_en: character.descriptionCard_en,
        name_en: character.name_en,
        greeting_en: character.greeting_en,
        description_en: character.description_en,
      },
    });
  } catch (error) {
    console.error("Get history error:", error);
    return NextResponse.json({ error: "Ошибка получения истории" }, { status: 500 });
  }
}
