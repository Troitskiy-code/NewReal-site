import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isMissingSlugColumn } from "@/lib/ensureCharacterSlug";
import { getApiLocale } from "@/lib/apiI18n";
import {
  resolveChatSystemPrompt,
  streamChatCompletion,
  trimMessagesToTokenLimit,
  type ChatCompletionMessage,
} from "@/lib/chatHelpers";
import { consumeOpenAIChatStream, createChatNdjsonResponse } from "@/lib/chatStream";
import {
  ANONYMOUS_LIMIT_CODE,
  ANONYMOUS_LIMIT_MESSAGE,
  attachAnonymousSessionCookie,
  consumeAnonymousMessage,
  getAnonymousRemaining,
  refundAnonymousMessage,
  resolveAnonymousSessionId,
} from "@/lib/anonymousSession";

const MAX_ANONYMOUS_HISTORY = 8;

type HistoryItem = {
  role: string;
  content: string;
};

function asHistory(value: unknown): HistoryItem[] {
  if (!Array.isArray(value)) return [];
  const items: HistoryItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const role = (entry as { role?: unknown }).role;
    const content = (entry as { content?: unknown }).content;
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      items.push({ role, content: content.trim() });
    }
    if (items.length >= MAX_ANONYMOUS_HISTORY) break;
  }
  return items;
}

async function resolveAnonymousModel() {
  const preferred = await prisma.model.findFirst({
    where: { isActive: true, name: "google/gemma-4-31b-it" },
    select: { id: true, name: true, displayName: true, maxContextTokens: true },
  });
  if (preferred) return preferred;

  const fallback = await prisma.model.findFirst({
    where: { isActive: true, name: "google/gemma-4-31b" },
    select: { id: true, name: true, displayName: true, maxContextTokens: true },
  });
  if (fallback) return fallback;

  return prisma.model.findFirst({
    where: { isActive: true },
    orderBy: { priceVC: "asc" },
    select: { id: true, name: true, displayName: true, maxContextTokens: true },
  });
}

function withCookie(response: NextResponse, sessionId: string, isNew: boolean): NextResponse {
  if (isNew) {
    attachAnonymousSessionCookie(response, sessionId);
  }
  return response;
}

export async function getAnonymousChatPayload(req: NextRequest, characterId: string) {
  const { sessionId, isNew } = resolveAnonymousSessionId(req);
  const remainingMessages = await getAnonymousRemaining(sessionId);

  const characterSelectNoSlug = {
    isPublic: true,
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
    return withCookie(
      NextResponse.json({ error: "Персонаж не найден" }, { status: 404 }),
      sessionId,
      isNew
    );
  }

  if (!character.isPublic) {
    return withCookie(
      NextResponse.json({ error: "Не авторизован" }, { status: 401 }),
      sessionId,
      isNew
    );
  }

  return withCookie(
    NextResponse.json({
      messages: [],
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
      anonymous: true,
      remainingMessages,
    }),
    sessionId,
    isNew
  );
}

export async function handleAnonymousChatPost(
  req: NextRequest,
  characterId: string,
  body: { message?: unknown; history?: unknown; continue?: unknown }
) {
  const { sessionId, isNew } = resolveAnonymousSessionId(req);

  if (body?.continue === true) {
    return withCookie(
      NextResponse.json({ error: "Продолжение доступно после регистрации" }, { status: 403 }),
      sessionId,
      isNew
    );
  }

  const message = body?.message;
  if (!message || typeof message !== "string" || !message.trim()) {
    return withCookie(
      NextResponse.json({ error: "Сообщение обязательно" }, { status: 400 }),
      sessionId,
      isNew
    );
  }

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
    return withCookie(
      NextResponse.json({ error: "Персонаж не найден" }, { status: 404 }),
      sessionId,
      isNew
    );
  }

  if (!character.isPublic) {
    return withCookie(
      NextResponse.json({ error: "Не авторизован" }, { status: 401 }),
      sessionId,
      isNew
    );
  }

  const consumed = await consumeAnonymousMessage(sessionId);
  if (!consumed.ok) {
    return withCookie(
      NextResponse.json(
        { error: ANONYMOUS_LIMIT_MESSAGE, code: ANONYMOUS_LIMIT_CODE, remainingMessages: 0 },
        { status: 403 }
      ),
      sessionId,
      isNew
    );
  }

  const model = await resolveAnonymousModel();
  if (!model) {
    await refundAnonymousMessage(sessionId);
    return withCookie(
      NextResponse.json({ error: "Модель недоступна" }, { status: 500 }),
      sessionId,
      isNew
    );
  }

  const locale = getApiLocale(req);
  const systemPrompt = resolveChatSystemPrompt(character, locale);
  const history = asHistory(body.history);
  const promptMessages: ChatCompletionMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map((item) => ({ role: item.role as "user" | "assistant", content: item.content })),
    { role: "user", content: message.trim() },
  ];
  const { messages: trimmedMessages } = trimMessagesToTokenLimit(
    promptMessages,
    Math.max(2000, (model.maxContextTokens ?? 4000) - 400)
  );

  const now = new Date().toISOString();
  const userMessage = {
    id: `anon-user-${Date.now()}`,
    role: "user",
    content: message.trim(),
    createdAt: now,
  };

  const streamResponse = createChatNdjsonResponse(async (emit) => {
    try {
      emit({ type: "meta", userMessage });
      console.log(
        `[Anonymous] Generating reply sessionId=${sessionId.slice(0, 8)}... model=${model.name} remaining=${consumed.remaining}`
      );

      const upstream = await streamChatCompletion(model.name, trimmedMessages, process.env.KODIKROUTER_API_KEY ?? "");
      const assistantReply = await consumeOpenAIChatStream(upstream, (text) => {
        emit({ type: "delta", text });
      });

      emit({
        type: "end",
        userMessage,
        assistantMessage: {
          id: `anon-assistant-${Date.now()}`,
          role: "assistant",
          content: assistantReply,
          createdAt: new Date().toISOString(),
        },
        model: { id: model.id, displayName: model.displayName },
        anonymous: true,
        remainingMessages: consumed.remaining,
      });
    } catch (error) {
      await refundAnonymousMessage(sessionId);
      throw error;
    }
  });

  const headers = new Headers(streamResponse.headers);
  const response = new NextResponse(streamResponse.body, {
    status: streamResponse.status,
    headers,
  });
  return withCookie(response, sessionId, isNew);
}
