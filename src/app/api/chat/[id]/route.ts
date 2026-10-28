import { insufficientBalanceMessage } from "@/lib/telegram/context";
import { isCharacterAllowedInTelegram } from "@/lib/telegram/catalog";
import { chatProviderConfigured } from "@/lib/aiProviders";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { withAiCostContext, setAiCostActor, setAiCostThread, recordChatCostCharge, aiCostDiagnosticContext } from "@/lib/aiCostTelemetry";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrCreateThreadPromptState, assertPromptStateAvailable, GroupPromptUnavailableError } from "@/lib/promptState";
import {
  chatThreadsEnabled,
  ensureDefaultThread,
  messageScopeWhere,
  requestedThreadId,
  resolveChatScope,
  scopeFor,
  toThreadSummary,
  markThreadActive,
  touchThread,
  type ChatScope,
} from "@/lib/chatThreads";
import { PromptBudgetError, withTurnReminder } from "@/lib/chatSystemPrompt";
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
import { memoryV2Enabled } from "@/lib/memoryFacts";
import { attachMemoryReply, drainMemoryJobs, enqueueMemoryTurn, finishMemoryTurn, invalidateMessageMemory, lockMemoryThread } from "@/lib/memoryV2";
import { resolveChatMemorySummary } from "@/lib/chatMemory";
import {
  assemblePreparedChatMessages,
  buildChatResponsePayload,
  reserveChatCharge,
  isAssistantMessageCutOff,
  logActionOptionsIfPresent,
  mergeAssistantContinuation,
  prepareFastContext,
  promptCharacterSelect,
  resolveChatContext,
  searchRagContext,
  streamChatCompletion,
  type ChatHistoryRow,
} from "@/lib/chatHelpers";
import {
  createChatNdjsonResponse,
  type ChatStreamEvent,
} from "@/lib/chatStream";
import { consumeOpenAIChatCompletion } from "@/lib/chatStreamDiagnostics";
import {
  calculateRequestCost,
  isSubscriptionActive,
} from "@/lib/verseChatEconomy";
import { getApiLocale } from "@/lib/apiI18n";
import { previewTranslationSelect, localizedCharacterText } from "@/lib/characterLocalization";
import { isFreeDailyQuotaEnabled } from "@/lib/freeDailyQuotaServer";
import { getAnonymousChatPayload, handleAnonymousChatPost } from "@/lib/anonymousChat";
import { defaultShouldRetry, KODIK_RETRY_ERROR_MESSAGE } from "@/lib/retryWithBackoff";
import { characterAvatarPath } from "@/lib/characterCardImage";

export const maxDuration = 120;

const KODIKROUTER_KEY = process.env.KODIKROUTER_API_KEY ?? "";

async function createMessageAndBumpTotal(scope: ChatScope, data: {
  role: string;
  content: string;
  finishReason?: "stop" | "length";
}, memoryUserMessageId?: string, appendMemoryReply = false) {
  const now = new Date();
  if (memoryV2Enabled()) return prisma.$transaction(async tx => {
    await lockMemoryThread(tx, scope.threadId);
    const message = await tx.message.create({ data: { ...data, characterId: scope.characterId, chatId: scope.characterId,
      userId: scope.userId, threadId: scope.threadId } });
    await tx.character.update({ where: { id: scope.characterId }, data: { totalMessages: { increment: 1 }, lastActive: now } });
    await tx.chatThread.update({ where: { id: scope.threadId }, data: { lastMessageAt: now, status: "active" } });
    if (data.role === "user") await enqueueMemoryTurn(tx, scope, message.id);
    if (data.role === "assistant" && memoryUserMessageId) await attachMemoryReply(tx, scope, memoryUserMessageId, message.id, appendMemoryReply);
    return message;
  });
  const [message] = await prisma.$transaction([
    // chatId keeps its legacy meaning (the character); the story is threadId.
    prisma.message.create({ data: { ...data, characterId: scope.characterId, chatId: scope.characterId, userId: scope.userId, threadId: scope.threadId } }),
    prisma.character.update({
      where: { id: scope.characterId },
      data: { totalMessages: { increment: 1 }, lastActive: now },
    }),
    touchThread(scope.threadId, now),
  ]);

  return message;
}

const THREAD_NOT_FOUND = "История не найдена";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAiCostContext(() => handlePost(req, context));
}

async function handlePost(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Set once the user's turn is stored; runs memory processing at most once per request.
  let scheduleTurnMemory: (assistantReply: string | null) => void = () => {};
  // Debited before generation; returned if the reply is never stored.
  let refundCharge: () => Promise<void> = async () => {};
  try {
    const session = await getServerSession(authOptions);
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "ID персонажа не указан" }, { status: 400 });
    }

    if (!chatProviderConfigured()) {
      return NextResponse.json({ error: "Провайдер чата не настроен" }, { status: 500 });
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
        ...promptCharacterSelect,
      },
    });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    if (!character.isPublic && character.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }
    // Telegram Mini App: only the Telegram catalog (and the viewer's own characters).
    if (!(await isCharacterAllowedInTelegram(character, session.user.id))) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    const body = await req.json();
    const continueChat = body?.continue === true;
    const retryLast = body?.retryLast === true;
    const message = body?.message;

    if (!continueChat && !retryLast && (!message || typeof message !== "string")) {
      return NextResponse.json({ error: "Сообщение обязательно" }, { status: 400 });
    }

    // A foreign or deleted story is rejected before anything is charged or written.
    const resolution = await resolveChatScope(session.user.id, id, requestedThreadId(req));
    if (resolution.status === "not_found") {
      return NextResponse.json({ error: THREAD_NOT_FOUND }, { status: 404 });
    }
    // Flag off, legacy rows without a story still exist; they join the story created below.
    if (resolution.status === "none" && !resolution.legacy && (continueChat || retryLast)) {
      return NextResponse.json({ error: continueChat ? "Нет сообщения ассистента для продолжения" : "Нет сообщения для повтора" }, { status: 400 });
    }

    const resolved = await resolveChatContext(session.user.id);
    if (!resolved) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    const { user, model, baseModel } = resolved;
    setAiCostActor(session.user.id, user.subscriptionType);
    const subscriptionActive = isSubscriptionActive(user);
    const persistEmbeddings = shouldPersistEmbeddings(user.subscriptionType, subscriptionActive);

    const costResult = calculateRequestCost(user, model, baseModel, { freeQuotaEnabled: isFreeDailyQuotaEnabled() });
    if (costResult.ok === false) {
      return NextResponse.json(
        {
          error: await insufficientBalanceMessage(costResult.error || "Недостаточно средств"),
          ...costResult.details,
        },
        { status: costResult.status || 402 }
      );
    }

    const charge = await reserveChatCharge({
      userId: session.user.id,
      costVC: costResult.priceVC,
      freeQuotaEligible: costResult.freeQuotaEligible,
      characterName: character.name,
      modelDisplayName: model.displayName,
    });
    if (charge.ok === false) {
      return NextResponse.json(
        {
          error: await insufficientBalanceMessage("Недостаточно VerseCoins"),
          requiredVC: costResult.priceVC,
          balance: charge.balance,
          ...(charge.freeQuota ? { freeQuota: charge.freeQuota } : {}),
        },
        { status: 402 }
      );
    }
    refundCharge = charge.refund;
    const costVC = charge.chargedVC;

    // The first message of a character creates its default story.
    const thread = resolution.status === "found" ? resolution.thread : await ensureDefaultThread(session.user.id, id);
    const scope = scopeFor(thread);
    setAiCostThread(scope.threadId);

    const locale = getApiLocale(req);
    const localizedGreeting = localizedCharacterText(character, "greeting", locale);
    let greetingMessage = null;
    let userMessage = null;
    let lastAssistant = null;
    let ragQueryText: string | undefined;
    let excludeMessageId: string | undefined;
    let continueCutOff = false;
    let memoryUserMessageId: string | undefined;

    // Pin the story type before inserting the first greeting or user turn.
    assertPromptStateAvailable(await getOrCreateThreadPromptState(scope), character.rpConfig);

    if (continueChat) {
      lastAssistant = await prisma.message.findFirst({
        where: {
          ...messageScopeWhere(scope),
          role: "assistant",
        },
        orderBy: { createdAt: "desc" },
      });

      if (!lastAssistant) {
        await refundCharge();
        return NextResponse.json({ error: "Нет сообщения ассистента для продолжения" }, { status: 400 });
      }

      continueCutOff = isAssistantMessageCutOff(lastAssistant.content, lastAssistant.finishReason);
      console.log(`📌 Обрыв обнаружен: ${continueCutOff ? "да" : "нет"}`);
      ragQueryText = lastAssistant.content;
      if (memoryV2Enabled()) {
        const priorUser = await prisma.message.findFirst({ where: { ...messageScopeWhere(scope), role: "user",
          createdAt: { lte: lastAssistant.createdAt } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        memoryUserMessageId = priorUser?.id;
      }
    } else if (retryLast) {
      const lastUser = await prisma.message.findFirst({
        where: {
          ...messageScopeWhere(scope),
          role: "user",
        },
        orderBy: { createdAt: "desc" },
      });

      if (!lastUser) {
        await refundCharge();
        return NextResponse.json({ error: "Нет сообщения для повтора" }, { status: 400 });
      }

      ragQueryText = lastUser.content;
      excludeMessageId = lastUser.id;
      memoryUserMessageId = lastUser.id;
    } else {
      const existingMessagesCount = await prisma.message.count({
        where: messageScopeWhere(scope),
      });

      // Every new story starts like a first visit: the card's greeting comes first.
      if (existingMessagesCount === 0 && localizedGreeting) {
        greetingMessage = await createMessageAndBumpTotal(scope, {
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

      userMessage = await createMessageAndBumpTotal(scope, {
        role: "user",
        content: message,
      });
      memoryUserMessageId = userMessage.id;

      scheduleMessageEmbedding(userMessage.id, message, KODIKROUTER_KEY, persistEmbeddings);
      ragQueryText = message;
      excludeMessageId = userMessage.id;
    }

    const ttftStartedAt = Date.now();
    const prepareOptions = {
      scope,
      character,
      user,
      model,
      apiKey: KODIKROUTER_KEY,
      ragQueryText,
      excludeMessageId,
      continueMode: continueChat,
      continueCutOff,
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
    const ragSearch = (intent: UserIntent, totalHistoryTokens: number, ragEligible: boolean, historyRows: ChatHistoryRow[]) =>
      searchRagContext({
        scope,
        apiKey: KODIKROUTER_KEY,
        ragQueryText,
        excludeMessageId,
        intent,
        ragEligible,
        totalHistoryTokens,
        historyRows,
      }).catch((error): RagMessage[] => {
        errorLog("Server", "[ChatTTFT] RAG failed, continuing without it", toSafeDiagnostic(error));
        return [];
      });
    // Question words and history length are known before intent; such searches start in parallel.
    const earlyRagPromise = fastContextPromise
      .then((context) =>
        shouldUseRag({ ragEligible: context.ragEligible, userQuery: ragQueryText, intent: "general", historyTokens: context.totalHistoryTokens }).use
          ? ragSearch("general", context.totalHistoryTokens, context.ragEligible, context.historyRows)
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
      ragMessages = decision.use ? await ragSearch(intent, fastContext.totalHistoryTokens, fastContext.ragEligible, fastContext.historyRows) : [];
    }
    console.log(`[ChatTTFT] RAG quotes: ${ragMessages.length}`);

    const { messages: trimmedMessages } = assemblePreparedChatMessages(fastContext, intent, ragMessages);

    if (!continueChat && !retryLast && typeof message === "string") {
      const userText = message;
      let turnMemoryScheduled = false;
      scheduleTurnMemory = (assistantReply) => {
        if (turnMemoryScheduled) return;
        turnMemoryScheduled = true;
        if (memoryV2Enabled() && userMessage) {
          const id = userMessage.id;
          void prisma.$transaction(tx => finishMemoryTurn(tx, id, null))
            .then(() => drainMemoryJobs({ threadId: scope.threadId, apiKey: KODIKROUTER_KEY }))
            .catch(error => errorLog("MemoryV2", "background drain deferred", toSafeDiagnostic(error)));
          return;
        }
        void ingestChatTurnMemory({
          scope,
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
      void resolveChatMemorySummary(scope, KODIKROUTER_KEY, user).catch((error) => {
        errorLog("Server", "[ChatTTFT] background summary refresh failed", toSafeDiagnostic(error));
      });
    }

    const upstream = await streamChatCompletion(model.name, withTurnReminder(trimmedMessages, locale), KODIKROUTER_KEY);

    let responseStage = "deliver_meta";
    const streamAndSaveReply = async (emit: (event: ChatStreamEvent) => void) => {
      emit({
        type: "meta",
        greetingMessage: greetingMessage ?? undefined,
        userMessage: userMessage ?? undefined,
        appendToId:
          continueChat && continueCutOff && lastAssistant ? lastAssistant.id : undefined,
        // Sending into an archived story makes it active again (touchThread), which the client shows.
        ...(chatThreadsEnabled() ? { threadId: scope.threadId, thread: { ...toThreadSummary(thread), status: "active" as const } } : {}),
      });

      let loggedTtft = false;
      responseStage = "consume_reply";
      const completion = await consumeOpenAIChatCompletion(upstream, (text) => {
        if (!loggedTtft) {
          loggedTtft = true;
          console.log(`[ChatTTFT] Total TTFT: ${Date.now() - ttftStartedAt}ms`);
        }
        emit({ type: "delta", text });
      }, undefined, () => emit({ type: "thinking" }));
      const assistantReply = completion.text;
      if (!loggedTtft) {
        console.log(`[ChatTTFT] Total TTFT: ${Date.now() - ttftStartedAt}ms`);
      }

      logActionOptionsIfPresent(assistantReply);

      await recordChatCostCharge(upstream, costVC);

      responseStage = "save_reply";
      const appendsToCutOff = Boolean(continueChat && continueCutOff && lastAssistant);
      const assistantMessage =
        appendsToCutOff && lastAssistant
          ? memoryV2Enabled() ? await prisma.$transaction(async tx => {
              await invalidateMessageMemory(tx, scope, lastAssistant.id);
              return tx.message.update({ where: { id: lastAssistant.id }, data: {
                content: mergeAssistantContinuation(lastAssistant.content, assistantReply), finishReason: completion.finishReason,
              } });
            }) : await prisma.message.update({
              where: { id: lastAssistant.id },
              data: {
                content: mergeAssistantContinuation(lastAssistant.content, assistantReply),
                finishReason: completion.finishReason,
              },
            })
          : await createMessageAndBumpTotal(scope, {
              role: "assistant",
              content: assistantReply,
              finishReason: completion.finishReason,
            }, memoryUserMessageId, continueChat);
      if (appendsToCutOff) await markThreadActive(scope.threadId);

      responseStage = "schedule_memory";
      (appendsToCutOff ? scheduleMessageEmbeddingRefresh : scheduleMessageEmbedding)(
        assistantMessage.id,
        assistantMessage.content,
        KODIKROUTER_KEY,
        persistEmbeddings
      );
      scheduleTurnMemory(assistantReply);
      if (memoryV2Enabled() && (continueChat || retryLast)) void drainMemoryJobs({ threadId: scope.threadId, apiKey: KODIKROUTER_KEY })
        .catch(error => errorLog("MemoryV2", "background drain deferred", toSafeDiagnostic(error)));
      // The reply is stored, so the debit is final.
      refundCharge = async () => {};

      responseStage = "deliver_end";
      emit({
        type: "end",
        ...buildChatResponsePayload({
          costVC,
          remainingVC: charge.remainingVC,
          freeQuota: charge.freeQuota,
          model,
          greetingMessage: greetingMessage ?? undefined,
          userMessage: userMessage ?? undefined,
          assistantMessage,
        }),
        ...(chatThreadsEnabled() ? { threadId: scope.threadId } : {}),
      });
    };

    return createChatNdjsonResponse(async (emit) => {
      try {
        await streamAndSaveReply(emit);
      } catch (error) {
        errorLog("ChatDiagnostics", "response failed", { ...aiCostDiagnosticContext(),
          stage: responseStage, reason: "response_pipeline_error", costVC }, toSafeDiagnostic(error));
        scheduleTurnMemory(null);
        await refundCharge();
        throw error;
      }
    });
  } catch (error) {
    scheduleTurnMemory(null);
    await refundCharge();
    if (error instanceof GroupPromptUnavailableError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof PromptBudgetError) return NextResponse.json({ error: error.message }, { status: 400 });
    errorLog("ChatDiagnostics", "request failed", { ...aiCostDiagnosticContext(), stage: "prepare_reply" }, toSafeDiagnostic(error));
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
      translations: { select: previewTranslationSelect },
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
    // Telegram Mini App: only the Telegram catalog (and the viewer's own characters).
    if (!(await isCharacterAllowedInTelegram(character, session.user.id))) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    // No story yet: an empty chat that the first message turns into the default story.
    const resolution = await resolveChatScope(session.user.id, id, requestedThreadId(req));
    if (resolution.status === "not_found") {
      return NextResponse.json({ error: THREAD_NOT_FOUND }, { status: 404 });
    }
    const messages = await prisma.message.findMany({
      where: resolution.status === "found"
        ? messageScopeWhere(resolution.scope)
        // Flag off before the story exists: rows still waiting for the backfill remain visible.
        : resolution.legacy ? { userId: session.user.id, characterId: id, threadId: null } : { id: { in: [] } },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({
      messages,
      threadsEnabled: chatThreadsEnabled(),
      thread: resolution.status === "found" && chatThreadsEnabled() ? toThreadSummary(resolution.thread) : null,
      character: {
        id: character.id,
        name: character.name,
        slug: "slug" in character ? character.slug : null,
        greeting: character.greeting,
        avatarUrl: characterAvatarPath(character.id, character.updatedAt),
        description: character.description,
        descriptionCard: character.descriptionCard,
        translations: character.translations,
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
