import { insufficientBalanceMessage } from "@/lib/telegram/context";
import { isCharacterAllowedInTelegram } from "@/lib/telegram/catalog";
import { chatProviderConfigured } from "@/lib/aiProviders";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { withAiCostContext, setAiCostActor, setAiCostThread, recordChatCostCharge, aiCostDiagnosticContext } from "@/lib/aiCostTelemetry";
import { chatThreadsEnabled, messageScopeWhere, requestedThreadId, resolveChatScope, markThreadActive } from "@/lib/chatThreads";
import { NextRequest, NextResponse } from "next/server";
import { GroupPromptUnavailableError } from "@/lib/promptState";
import { PromptBudgetError, withTurnReminder } from "@/lib/chatSystemPrompt";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  buildChatResponsePayload,
  reserveChatCharge,
  logActionOptionsIfPresent,
  prepareChatMessages,
  promptCharacterSelect,
  resolveChatContext,
  streamChatCompletion,
} from "@/lib/chatHelpers";
import { analyzeIntent } from "@/lib/intentAnalyzer";
import {
  createChatNdjsonResponse,
  type ChatStreamEvent,
} from "@/lib/chatStream";
import { consumeOpenAIChatCompletion } from "@/lib/chatStreamDiagnostics";
import { calculateRequestCost, isSubscriptionActive } from "@/lib/verseChatEconomy";
import { scheduleMessageEmbeddingRefresh, shouldPersistEmbeddings } from "@/lib/messageEmbeddings";
import { getApiLocale } from "@/lib/apiI18n";
import { isFreeDailyQuotaEnabled } from "@/lib/freeDailyQuotaServer";
import { defaultShouldRetry, KODIK_RETRY_ERROR_MESSAGE } from "@/lib/retryWithBackoff";

export const maxDuration = 120;

const KODIKROUTER_KEY = process.env.KODIKROUTER_API_KEY ?? "";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAiCostContext(() => handlePost(req, context));
}

async function handlePost(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Debited before generation; returned if the new reply is never stored.
  let refundCharge: () => Promise<void> = async () => {};
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    if (!chatProviderConfigured()) {
      return NextResponse.json({ error: "Провайдер чата не настроен" }, { status: 500 });
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
        threadId: true,
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

    // The story is the message's own; a different story in the request is treated as not found.
    const requested = requestedThreadId(req);
    if (chatThreadsEnabled() && requested !== null && assistantMessage.threadId && requested !== assistantMessage.threadId) {
      return NextResponse.json({ error: "История не найдена" }, { status: 404 });
    }
    // Flag off, a legacy row may predate its pair's story; the story is created and includes it.
    const resolution = await resolveChatScope(session.user.id, characterId, assistantMessage.threadId ?? requested,
      { create: !chatThreadsEnabled() });
    if (resolution.status !== "found") {
      return NextResponse.json({ error: "История не найдена" }, { status: 404 });
    }
    const { scope } = resolution;

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
    // Telegram Mini App: only the Telegram catalog (and the viewer's own characters).
    if (!(await isCharacterAllowedInTelegram(character, session.user.id))) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    const resolved = await resolveChatContext(session.user.id);
    if (!resolved) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    const { user, model, baseModel } = resolved;
    setAiCostActor(session.user.id, user.subscriptionType);
    setAiCostThread(scope.threadId);

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

    const previousUserMessage = await prisma.message.findFirst({
      where: {
        ...messageScopeWhere(scope),
        role: "user",
        createdAt: { lt: assistantMessage.createdAt },
      },
      orderBy: { createdAt: "desc" },
    });

    const intent = previousUserMessage
      ? (await analyzeIntent(previousUserMessage.content, KODIKROUTER_KEY)).intent
      : "general";

    const { messages: trimmedMessages } = await prepareChatMessages({
      scope,
      character,
      user,
      model,
      apiKey: KODIKROUTER_KEY,
      ragQueryText: previousUserMessage?.content ?? assistantMessage.content,
      // The reply being replaced must not come back as a quote of itself.
      excludeMessageId: assistantMessage.id,
      historyBeforeMessageId: assistantMessage.id,
      intent,
      locale: getApiLocale(req),
      // Regeneration adds no messages; the summary refresh (up to its 90 s timeout) stays off the reply path.
      refreshSummary: false,
    });

    const upstream = await streamChatCompletion(model.name, withTurnReminder(trimmedMessages, getApiLocale(req)), KODIKROUTER_KEY);

    let responseStage = "deliver_meta";
    const streamAndSaveReply = async (emit: (event: ChatStreamEvent) => void) => {
      emit({
        type: "meta",
        appendToId: assistantMessage.id,
      });

      responseStage = "consume_reply";
      const completion = await consumeOpenAIChatCompletion(upstream, (text) => {
        emit({ type: "delta", text });
      }, undefined, () => emit({ type: "thinking" }));
      const assistantReply = completion.text;

      logActionOptionsIfPresent(assistantReply);

      await recordChatCostCharge(upstream, costVC);

      responseStage = "save_reply";
      const updatedMessage = await prisma.message.update({
        where: { id: assistantMessage.id },
        data: {
          content: assistantReply,
          finishReason: completion.finishReason,
          createdAt: new Date(),
        },
      });
      await markThreadActive(scope.threadId);
      responseStage = "schedule_memory";
      scheduleMessageEmbeddingRefresh(
        updatedMessage.id,
        updatedMessage.content,
        KODIKROUTER_KEY,
        shouldPersistEmbeddings(user.subscriptionType, isSubscriptionActive(user))
      );
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
          assistantMessage: updatedMessage,
        }),
      });
    };

    return createChatNdjsonResponse(async (emit) => {
      try {
        await streamAndSaveReply(emit);
      } catch (error) {
        errorLog("ChatDiagnostics", "response failed", { ...aiCostDiagnosticContext(),
          stage: responseStage, reason: "response_pipeline_error", costVC }, toSafeDiagnostic(error));
        await refundCharge();
        throw error;
      }
    });
  } catch (error) {
    await refundCharge();
    if (error instanceof GroupPromptUnavailableError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof PromptBudgetError) return NextResponse.json({ error: error.message }, { status: 400 });
    errorLog("ChatDiagnostics", "request failed", { ...aiCostDiagnosticContext(), stage: "prepare_regenerate" }, toSafeDiagnostic(error));
    if (defaultShouldRetry(error)) {
      return NextResponse.json(
        { error: KODIK_RETRY_ERROR_MESSAGE },
        { status: 503, headers: { "Retry-After": "10" } }
      );
    }
    return NextResponse.json({ error: "Ошибка при перегенерации ответа" }, { status: 500 });
  }
}
