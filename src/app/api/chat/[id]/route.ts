import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { withAiCostContext, setAiCostActor, recordChatCostCharge } from "@/lib/aiCostTelemetry";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensureCharacterSlugColumn, isMissingSlugColumn } from "@/lib/ensureCharacterSlug";
import {
  scheduleMessageEmbedding,
  scheduleMessageEmbeddingRefresh,
  shouldPersistEmbeddings,
  shouldUseRag,
  type RagMessage,
} from "@/lib/messageEmbeddings";
import { analyzeIntent, type UserIntent } from "@/lib/intentAnalyzer";
import { ingestChatTurnMemory } from "@/lib/advancedMemory";
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
  streamChatCompletion,
} from "@/lib/chatHelpers";
import {
  consumeOpenAIChatCompletion,
  createChatNdjsonResponse,
  type ChatStreamEvent,
} from "@/lib/chatStream";
import {
  calculateRequestCost,
  isSubscriptionActive,
} from "@/lib/verseChatEconomy";
import { getApiLocale } from "@/lib/apiI18n";
import { getAnonymousChatPayload, handleAnonymousChatPost } from "@/lib/anonymousChat";
import { defaultShouldRetry, KODIK_RETRY_ERROR_MESSAGE } from "@/lib/retryWithBackoff";
import { characterAvatarPath } from "@/lib/characterCardImage";

export const maxDuration = 120;

const KODIKROUTER_KEY = process.env.KODIKROUTER_API_KEY ?? "";

async function createMessageAndBumpTotal(data: {
  characterId: string;
  chatId: string;
  userId: string;
  role: string;
  content: string;
  finishReason?: "stop" | "length";
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

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAiCostContext(() => handlePost(req, context));
}

async function handlePost(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Set once the user's turn is stored; runs memory processing at most once per request.
  let scheduleTurnMemory: (assistantReply: string | null) => void = () => {};
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
    const retryLast = body?.retryLast === true;
    const message = body?.message;

    if (!continueChat && !retryLast && (!message || typeof message !== "string")) {
      return NextResponse.json({ error: "Сообщение обязательно" }, { status: 400 });
    }

    const resolved = await resolveChatContext(session.user.id);
    if (!resolved) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    const { user, model, baseModel } = resolved;
    setAiCostActor(session.user.id, user.subscriptionType);
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

      continueCutOff = isAssistantMessageCutOff(lastAssistant.content, lastAssistant.finishReason);
      console.log(`📌 Обрыв обнаружен: ${continueCutOff ? "да" : "нет"}`);
      ragQueryText = lastAssistant.content;
    } else if (retryLast) {
      const lastUser = await prisma.message.findFirst({
        where: {
          characterId: id,
          userId: session.user.id,
          role: "user",
        },
        orderBy: { createdAt: "desc" },
      });

      if (!lastUser) {
        return NextResponse.json({ error: "Нет сообщения для повтора" }, { status: 400 });
      }

      ragQueryText = lastUser.content;
      excludeMessageId = lastUser.id;
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

    const fastContextPromise = (async () => {
      const started = Date.now();
      try {
        const context = await prepareFastContext(prepareOptions);
        console.log(`[ChatTTFT] Fast context prepared in ${Date.now() - started}ms`);
        return context;
      } catch (error) {
        errorLog("Server", "[ChatTTFT] Fast context failed", toSafeDiagnostic(error));
        throw error;
      }
    })();
    const ragSearch = (intent: UserIntent, totalHistoryTokens: number, ragEligible: boolean) =>
      searchRagContext({
        userId: session.user.id,
        characterId: id,
        apiKey: KODIKROUTER_KEY,
        ragQueryText,
        excludeMessageId,
        intent,
        ragEligible,
        totalHistoryTokens,
      }).catch((error): RagMessage[] => {
        errorLog("Server", "[ChatTTFT] RAG failed, continuing without it", toSafeDiagnostic(error));
        return [];
      });
    // Question words and history length are known before intent; such searches start in parallel.
    const earlyRagPromise = fastContextPromise
      .then((context) =>
        shouldUseRag({ ragEligible: context.ragEligible, userQuery: ragQueryText, intent: "general", historyTokens: context.totalHistoryTokens }).use
          ? ragSearch("general", context.totalHistoryTokens, context.ragEligible)
          : null
      )
      .catch(() => null);

    const [fastContext, analysis] = await Promise.all([
      fastContextPromise,
      (async () => {
        if (continueChat || retryLast || typeof message !== "string") {
          console.log("[ChatTTFT] Intent analysis: general, 0ms");
          return { intent: "general" as const, confidence: 0 };
        }
        const started = Date.now();
        try {
          const result = await analyzeIntent(message, KODIKROUTER_KEY);
          console.log(`[ChatTTFT] Intent analysis: ${result.intent}, ${Date.now() - started}ms`);
          return result;
        } catch (error) {
          errorLog("Server", "[ChatTTFT] Intent analysis failed, fallback general", toSafeDiagnostic(error));
          console.log(`[ChatTTFT] Intent analysis: general, ${Date.now() - started}ms`);
          return { intent: "general" as const, confidence: 0 };
        }
      })(),
    ]);

    const intent = analysis.intent;
    let ragMessages = await earlyRagPromise;
    if (ragMessages === null) {
      const decision = shouldUseRag({
        ragEligible: fastContext.ragEligible,
        userQuery: ragQueryText,
        intent,
        historyTokens: fastContext.totalHistoryTokens,
      });
      ragMessages = decision.use ? await ragSearch(intent, fastContext.totalHistoryTokens, fastContext.ragEligible) : [];
    }
    console.log(`[ChatTTFT] RAG quotes: ${ragMessages.length}`);

    const { messages: trimmedMessages } = assemblePreparedChatMessages(fastContext, intent, ragMessages);

    if (!continueChat && !retryLast && typeof message === "string") {
      const userText = message;
      let turnMemoryScheduled = false;
      scheduleTurnMemory = (assistantReply) => {
        if (turnMemoryScheduled) return;
        turnMemoryScheduled = true;
        void ingestChatTurnMemory({
          userId: session.user.id,
          characterId: id,
          userMessage: userText,
          assistantReply,
          intent,
          // Preserve story order even when background classifiers finish out of order.
          timestamp: userMessage?.createdAt,
          apiKey: KODIKROUTER_KEY,
        }).catch((error) => {
          errorLog("Server", "[ChatTTFT] background memory ingest failed", toSafeDiagnostic(error));
        });
      };
      void resolveChatMemorySummary(session.user.id, id, KODIKROUTER_KEY, user).catch((error) => {
        errorLog("Server", "[ChatTTFT] background summary refresh failed", toSafeDiagnostic(error));
      });
    }

    const upstream = await streamChatCompletion(model.name, trimmedMessages, KODIKROUTER_KEY);

    const streamAndSaveReply = async (emit: (event: ChatStreamEvent) => void) => {
      emit({
        type: "meta",
        greetingMessage: greetingMessage ?? undefined,
        userMessage: userMessage ?? undefined,
        appendToId:
          continueChat && continueCutOff && lastAssistant ? lastAssistant.id : undefined,
      });

      let loggedTtft = false;
      const completion = await consumeOpenAIChatCompletion(upstream, (text) => {
        if (!loggedTtft) {
          loggedTtft = true;
          console.log(`[ChatTTFT] Total TTFT: ${Date.now() - ttftStartedAt}ms`);
        }
        emit({ type: "delta", text });
      });
      const assistantReply = completion.text;
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

      await recordChatCostCharge(upstream, costVC);

      const appendsToCutOff = Boolean(continueChat && continueCutOff && lastAssistant);
      const assistantMessage =
        appendsToCutOff && lastAssistant
          ? await prisma.message.update({
              where: { id: lastAssistant.id },
              data: {
                content: mergeAssistantContinuation(lastAssistant.content, assistantReply),
                finishReason: completion.finishReason,
              },
            })
          : await createMessageAndBumpTotal({
              characterId: id,
              chatId: id,
              userId: session.user.id,
              role: "assistant",
              content: assistantReply,
              finishReason: completion.finishReason,
            });

      (appendsToCutOff ? scheduleMessageEmbeddingRefresh : scheduleMessageEmbedding)(
        assistantMessage.id,
        assistantMessage.content,
        KODIKROUTER_KEY,
        persistEmbeddings
      );
      scheduleTurnMemory(assistantReply);

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
    };

    return createChatNdjsonResponse(async (emit) => {
      try {
        await streamAndSaveReply(emit);
      } catch (error) {
        scheduleTurnMemory(null);
        throw error;
      }
    });
  } catch (error) {
    scheduleTurnMemory(null);
    errorLog("Server", "Chat error:", toSafeDiagnostic(error));
    if (defaultShouldRetry(error)) {
      return NextResponse.json(
        { error: KODIK_RETRY_ERROR_MESSAGE },
        { status: 503, headers: { "Retry-After": "10" } }
      );
    }
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
      errorLog("Server", "[chat] Could not ensure slug column", toSafeDiagnostic(error));
    }

    const characterSelectNoSlug = {
      id: true,
      isPublic: true,
      userId: true,
      name: true,
      greeting: true,
      updatedAt: true,
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
        id: character.id,
        name: character.name,
        slug: "slug" in character ? character.slug : null,
        greeting: character.greeting,
        avatarUrl: characterAvatarPath(character.id, character.updatedAt),
        description: character.description,
        descriptionCard: character.descriptionCard,
        descriptionCard_en: character.descriptionCard_en,
        name_en: character.name_en,
        greeting_en: character.greeting_en,
        description_en: character.description_en,
      },
    });
  } catch (error) {
    errorLog("Server", "Get history error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Ошибка получения истории" }, { status: 500 });
  }
}
