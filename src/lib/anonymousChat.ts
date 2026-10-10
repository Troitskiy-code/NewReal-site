import { setAiCostActor } from "@/lib/aiCostTelemetry";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isMissingSlugColumn } from "@/lib/ensureCharacterSlug";
import { characterAvatarPath } from "@/lib/characterCardImage";
import { getApiLocale } from "@/lib/apiI18n";
import {
  resolveContextTokenBudget,
  resolveChatSystemPrompt,
  streamChatCompletion,
  trimMessagesToTokenLimit,
  type ChatCompletionMessage,
} from "@/lib/chatHelpers";
import { consumeOpenAIChatStream, createChatNdjsonResponse } from "@/lib/chatStream";
import { defaultShouldRetry, KODIK_RETRY_ERROR_MESSAGE } from "@/lib/retryWithBackoff";
import {
  ANONYMOUS_LIMIT_CODE,
  ANONYMOUS_LIMIT_MESSAGE,
  attachAnonymousSessionCookie,
  ensureAnonymousSession,
  getAnonymousMessageLimit,
  getAnonymousRemaining,
  resolveAnonymousSessionId,
} from "@/lib/anonymousSession";
import {
  ANONYMOUS_TTL_DAYS,
  createAnonymousSessionId,
  isValidAnonymousRequestId,
} from "@/lib/anonymousCookie";
import { clientKeyFromRequest, consumeRateLimit } from "@/lib/rateLimit";
import { MAX_ANONYMOUS_HISTORY, normalizeGuestMessage } from "@/lib/guestRequestPolicy";
import {
  GuestSchemaMissingError,
  assertGuestSchemaReady,
  claimGuestGeneration,
  failGuestGeneration,
  finalizeGuestGeneration,
  persistGuestUserMessage,
  recoverGuestSession,
  renewGuestGeneration,
} from "@/lib/guestRequestStore";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NON_DEFAULT_CHAT_MODEL_NAMES } from "@/lib/testingChatModels";

const ANON_POST_LIMIT = 30;
const ANON_POST_WINDOW_MS = 60_000;

function startGuestHeartbeat(params: { sessionId: string; requestId: string; attempt: number }) {
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void renewGuestGeneration(params)
      .then((active) => { if (!active) clearInterval(timer); })
      .catch((error) => errorLog("Anonymous", "lease renewal failed", toSafeDiagnostic(error)))
      .finally(() => { renewing = false; });
  }, 20_000);
  timer.unref();
  return () => clearInterval(timer);
}

async function resolveAnonymousModel() {
  const preferred = await prisma.model.findFirst({
    where: { isActive: true, name: "google/gemma-4-31b-it" },
    select: { id: true, name: true, displayName: true, maxContextTokens: true },
  });
  if (preferred) return preferred;
  return prisma.model.findFirst({
    where: { isActive: true, name: { notIn: NON_DEFAULT_CHAT_MODEL_NAMES } },
    orderBy: { priceVC: "asc" },
    select: { id: true, name: true, displayName: true, maxContextTokens: true },
  });
}

function withCookie(response: NextResponse, sessionId: string): NextResponse {
  attachAnonymousSessionCookie(response, sessionId);
  return response;
}

function schemaError(sessionId: string) {
  return withCookie(
    NextResponse.json({ error: "Гостевой чат временно недоступен", code: "SCHEMA_NOT_READY" }, { status: 503 }),
    sessionId
  );
}

async function loadStoredMessages(sessionId: string, characterId: string) {
  return prisma.anonymousMessage.findMany({
    where: { sessionId, characterId, transferredAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, content: true, createdAt: true },
    take: MAX_ANONYMOUS_HISTORY * 2,
  });
}

export async function getAnonymousChatPayload(req: NextRequest, characterId: string) {
  const { sessionId, isNew } = resolveAnonymousSessionId(req);
  try {
    await assertGuestSchemaReady();
  } catch (error) {
    if (error instanceof GuestSchemaMissingError) return schemaError(sessionId);
    throw error;
  }

  const session = await ensureAnonymousSession(sessionId);
  if (session.transferredToUserId) {
    return withCookie(
      NextResponse.json({ error: "Гостевая сессия перенесена", code: "GUEST_REVOKED", messages: [] }, { status: 403 }),
      sessionId
    );
  }

  if (session.expired) {
    const nextId = createAnonymousSessionId();
    await ensureAnonymousSession(nextId);
    return withCookie(
      NextResponse.json(
        {
          error: "Гостевой диалог истёк. Начните новый или войдите в аккаунт.",
          code: "ANONYMOUS_EXPIRED",
          messages: [],
          anonymous: true,
          remainingMessages: 0,
          retentionDays: ANONYMOUS_TTL_DAYS,
        },
        { status: 410 }
      ),
      nextId
    );
  }

  await recoverGuestSession(sessionId);
  const remainingMessages = await getAnonymousRemaining(sessionId);
  const characterSelectNoSlug = {
    id: true,
    isPublic: true,
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
      where: { id: characterId },
      select: { ...characterSelectNoSlug, slug: true },
    });
  } catch (error) {
    if (!isMissingSlugColumn(error)) throw error;
    character = await prisma.character.findUnique({
      where: { id: characterId },
      select: characterSelectNoSlug,
    });
  }

  if (!character) {
    return withCookie(NextResponse.json({ error: "Персонаж не найден" }, { status: 404 }), sessionId);
  }
  if (!character.isPublic) {
    return withCookie(NextResponse.json({ error: "Не авторизован" }, { status: 401 }), sessionId);
  }

  const messages = await loadStoredMessages(sessionId, characterId);
  return withCookie(
    NextResponse.json({
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
      anonymous: true,
      remainingMessages,
      retentionDays: ANONYMOUS_TTL_DAYS,
      expiresAt: session.expiresAt,
    }),
    sessionId
  );
}

function replayResponse(existing: {
  userMessageId: string | null;
  assistantMessageId: string | null;
  userContent: string;
  assistantContent: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  remainingMessages: number | null;
}, sessionId: string) {
  const createdAt = (existing.createdAt ?? new Date()).toISOString();
  const userMessage = {
    id: existing.userMessageId ?? "anon-user-replay",
    role: "user",
    content: existing.userContent,
    createdAt,
  };
  const assistantMessage = {
    id: existing.assistantMessageId ?? "anon-assistant-replay",
    role: "assistant",
    content: existing.assistantContent ?? "",
    createdAt: (existing.updatedAt ?? existing.createdAt ?? new Date()).toISOString(),
  };
  const streamResponse = createChatNdjsonResponse(async (emit) => {
    emit({ type: "meta", userMessage });
    emit({ type: "delta", text: assistantMessage.content });
    emit({
      type: "end",
      userMessage,
      assistantMessage,
      anonymous: true,
      remainingMessages: existing.remainingMessages ?? 0,
    });
  });
  return withCookie(
    new NextResponse(streamResponse.body, { status: streamResponse.status, headers: streamResponse.headers }),
    sessionId
  );
}

export async function handleAnonymousChatPost(
  req: NextRequest,
  characterId: string,
  body: { message?: unknown; history?: unknown; continue?: unknown; requestId?: unknown }
) {
  const { sessionId } = resolveAnonymousSessionId(req);
  setAiCostActor(`guest:${sessionId}`, "start");
  try {
    await assertGuestSchemaReady();
  } catch (error) {
    if (error instanceof GuestSchemaMissingError) return schemaError(sessionId);
    throw error;
  }

  const limited = await consumeRateLimit(`anon-post:${clientKeyFromRequest(req)}`, ANON_POST_LIMIT, ANON_POST_WINDOW_MS);
  if (!limited.ok) {
    return withCookie(NextResponse.json({ error: "Слишком много запросов. Подождите немного." }, { status: 429 }), sessionId);
  }

  if (body?.continue === true) {
    return withCookie(NextResponse.json({ error: "Продолжение доступно после регистрации" }, { status: 403 }), sessionId);
  }

  const message = normalizeGuestMessage(body?.message);
  if (!message) {
    return withCookie(NextResponse.json({ error: "Сообщение обязательно" }, { status: 400 }), sessionId);
  }
  if (!isValidAnonymousRequestId(body.requestId)) {
    return withCookie(NextResponse.json({ error: "Некорректный идентификатор запроса" }, { status: 400 }), sessionId);
  }
  const requestId = body.requestId;

  const character = await prisma.character.findUnique({
    where: { id: characterId },
    select: {
      id: true,
      isPublic: true,
      name: true,
      description: true,
      appearance: true,
      greeting: true,
      scenario: true,
      exampleDialogs: true,
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
    return withCookie(NextResponse.json({ error: "Персонаж не найден" }, { status: 404 }), sessionId);
  }
  if (!character.isPublic) {
    return withCookie(NextResponse.json({ error: "Не авторизован" }, { status: 401 }), sessionId);
  }

  const claimed = await claimGuestGeneration({
    sessionId,
    requestId,
    characterId,
    message,
    quotaLimit: getAnonymousMessageLimit(),
  });

  if (claimed.kind === "revoked") {
    return withCookie(NextResponse.json({ error: "Гостевая сессия перенесена", code: "GUEST_REVOKED" }, { status: 403 }), sessionId);
  }
  if (claimed.kind === "expired") {
    return withCookie(NextResponse.json({ error: "Гостевой диалог истёк", code: "ANONYMOUS_EXPIRED" }, { status: 410 }), sessionId);
  }
  if (claimed.kind === "conflict") {
    return withCookie(NextResponse.json({ error: "Конфликт идентификатора запроса", code: "REQUEST_CONFLICT" }, { status: 409 }), sessionId);
  }
  if (claimed.kind === "in_progress") {
    return withCookie(NextResponse.json({ error: "Запрос уже обрабатывается", code: "REQUEST_IN_PROGRESS" }, { status: 409 }), sessionId);
  }
  if (claimed.kind === "quota") {
    return withCookie(
      NextResponse.json({ error: ANONYMOUS_LIMIT_MESSAGE, code: ANONYMOUS_LIMIT_CODE, remainingMessages: 0 }, { status: 403 }),
      sessionId
    );
  }
  if (claimed.kind === "replay") {
    return replayResponse(claimed.request, sessionId);
  }

  const generation = { sessionId, requestId, attempt: claimed.attempt };
  const stopHeartbeat = startGuestHeartbeat(generation);
  try {
    const userRow = await persistGuestUserMessage({ ...generation, characterId, message });
    if (!userRow) {
      stopHeartbeat();
      return withCookie(NextResponse.json({ error: "Попытка уже завершена", code: "REQUEST_IN_PROGRESS" }, { status: 409 }), sessionId);
    }
    const userMessageId = userRow.id;
    const userMessage = {
      id: userMessageId,
      role: "user" as const,
      content: message,
      createdAt: (userRow?.createdAt ?? new Date()).toISOString(),
    };

    const model = await resolveAnonymousModel();
    if (!model) {
      stopHeartbeat();
      await failGuestGeneration({ sessionId, requestId, attempt: claimed.attempt });
      return withCookie(NextResponse.json({ error: "Модель недоступна" }, { status: 500 }), sessionId);
    }

    const locale = getApiLocale(req);
    const systemPrompt = resolveChatSystemPrompt(character, locale);
    const stored = await loadStoredMessages(sessionId, characterId);
    const history = stored
      .filter((item) => item.id !== userMessageId)
      .slice(-MAX_ANONYMOUS_HISTORY);
    const promptMessages: ChatCompletionMessage[] = [
      { role: "system", content: systemPrompt },
      ...history.map((item) => ({ role: item.role as "user" | "assistant", content: item.content })),
      { role: "user", content: message },
    ];
    const { messages: trimmedMessages } = trimMessagesToTokenLimit(
      promptMessages,
      resolveContextTokenBudget({ subscriptionType: "start", subscriptionEnd: null }, model)
    );

    const stubReply =
      process.env.NODE_ENV === "production" ? "" : (process.env['GUEST_AI_STUB_REPLY'] ?? "").trim();
    let upstream: ReadableStream<Uint8Array>;
    if (stubReply) {
      const attempt = claimed.attempt;
      const remaining = claimed.remaining;
      const streamResponse = createChatNdjsonResponse(async (emit) => {
        try {
          emit({ type: "meta", userMessage });
          emit({ type: "delta", text: stubReply });
          const finalized = await finalizeGuestGeneration({
            sessionId,
            requestId,
            attempt,
            characterId,
            assistantContent: stubReply,
            userMessageId,
            remainingMessages: remaining,
          });
          if (!finalized) return;
          emit({
            type: "end",
            userMessage,
            assistantMessage: {
              id: finalized.assistantMessageId,
              role: "assistant",
              content: stubReply,
              createdAt: new Date().toISOString(),
            },
            model: { id: model.id, displayName: model.displayName },
            anonymous: true,
            remainingMessages: remaining,
          });
        } catch (error) {
          await failGuestGeneration(generation);
          throw error;
        } finally {
          stopHeartbeat();
        }
      });
      return withCookie(
        new NextResponse(streamResponse.body, { status: streamResponse.status, headers: streamResponse.headers }),
        sessionId
      );
    }

    try {
      upstream = await streamChatCompletion(model.name, trimmedMessages, process.env.KODIKROUTER_API_KEY ?? "");
    } catch (error) {
      stopHeartbeat();
      await failGuestGeneration({ sessionId, requestId, attempt: claimed.attempt });
      if (defaultShouldRetry(error)) {
        return withCookie(
          NextResponse.json({ error: KODIK_RETRY_ERROR_MESSAGE }, { status: 503, headers: { "Retry-After": "10" } }),
          sessionId
        );
      }
      return withCookie(NextResponse.json({ error: "Ошибка при обработке запроса" }, { status: 500 }), sessionId);
    }

    const attempt = claimed.attempt;
    const remaining = claimed.remaining;
    const streamResponse = createChatNdjsonResponse(async (emit) => {
      try {
        emit({ type: "meta", userMessage });
        const assistantReply = await consumeOpenAIChatStream(upstream, (text) => {
          emit({ type: "delta", text });
        }, AbortSignal.timeout(120_000));
        const finalized = await finalizeGuestGeneration({
          sessionId,
          requestId,
          attempt,
          characterId,
          assistantContent: assistantReply,
          userMessageId,
          remainingMessages: remaining,
        });
        if (!finalized) {
          return;
        }
        emit({
          type: "end",
          userMessage,
          assistantMessage: {
            id: finalized.assistantMessageId,
            role: "assistant",
            content: assistantReply,
            createdAt: new Date().toISOString(),
          },
          model: { id: model.id, displayName: model.displayName },
          anonymous: true,
          remainingMessages: remaining,
        });
      } catch (error) {
        await failGuestGeneration({ sessionId, requestId, attempt });
        throw error;
      } finally {
        stopHeartbeat();
      }
    });

    return withCookie(
      new NextResponse(streamResponse.body, { status: streamResponse.status, headers: streamResponse.headers }),
      sessionId
    );
  } catch (error) {
    stopHeartbeat();
    errorLog("Anonymous", "generation preparation failed", toSafeDiagnostic(error));
    try {
      await failGuestGeneration(generation);
    } catch (cleanupError) {
      errorLog("Anonymous", "generation recovery deferred", toSafeDiagnostic(cleanupError));
    }
    return withCookie(NextResponse.json({ error: "Ошибка при обработке запроса" }, { status: 500 }), sessionId);
  }
}
