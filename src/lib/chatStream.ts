export type ChatStreamMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: string | Date;
};

export type ChatStreamMetaEvent = {
  type: "meta";
  greetingMessage?: ChatStreamMessage;
  userMessage?: ChatStreamMessage;
  appendToId?: string;
};

export type ChatStreamDeltaEvent = {
  type: "delta";
  text: string;
};

export type ChatStreamEndEvent = {
  type: "end";
  assistantMessage: ChatStreamMessage;
  greetingMessage?: ChatStreamMessage;
  userMessage?: ChatStreamMessage;
  remainingVC?: number;
  dailyRequests?: number;
  dailyLimit?: number;
  chargedVC?: number;
  limitWarning?: string | null;
  model?: { id: string; displayName: string };
};

export type ChatStreamErrorEvent = {
  type: "error";
  error: string;
};

export type ChatStreamEvent =
  | ChatStreamMetaEvent
  | ChatStreamDeltaEvent
  | ChatStreamEndEvent
  | ChatStreamErrorEvent;

export class ChatStreamRequestError extends Error {
  status: number;
  payload: { error?: string };

  constructor(message: string, status = 500, payload: { error?: string } = {}) {
    super(message);
    this.name = "ChatStreamRequestError";
    this.status = status;
    this.payload = payload;
  }
}

const encoder = new TextEncoder();

export function encodeChatStreamEvent(event: ChatStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

export function extractChatStreamDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }

  const choice = choices[0] as Record<string, unknown>;
  const delta = choice.delta;
  if (delta && typeof delta === "object") {
    const content = (delta as Record<string, unknown>).content;
    if (typeof content === "string") {
      return content;
    }
  }

  if (typeof choice.text === "string") {
    return choice.text;
  }

  const message = choice.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") {
      return content;
    }
  }

  return "";
}

export function createChatNdjsonResponse(
  run: (emit: (event: ChatStreamEvent) => void) => Promise<void>
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatStreamEvent) => {
        controller.enqueue(encodeChatStreamEvent(event));
      };

      try {
        await run(emit);
      } catch (error) {
        console.error("Chat stream error:", error);
        try {
          emit({
            type: "error",
            error: error instanceof Error && error.message === "Пустой ответ от ИИ"
              ? error.message
              : "Ошибка при обработке запроса",
          });
        } catch {
          // Client already disconnected.
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function consumeOpenAIChatStream(
  stream: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) {
      return;
    }

    const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    if (!payload || payload === "[DONE]") {
      return;
    }

    try {
      const delta = extractChatStreamDelta(JSON.parse(payload) as unknown);
      if (delta) {
        fullText += delta;
        onDelta(delta);
      }
    } catch {
      // Incomplete or non-JSON chunk.
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(line);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      consumeLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }

  const reply = fullText.trim();
  if (!reply) {
    throw new Error("Пустой ответ от ИИ");
  }

  return reply;
}

function isChatStreamEvent(value: unknown): value is ChatStreamEvent {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }
  const type = (value as { type: unknown }).type;
  return type === "meta" || type === "delta" || type === "end" || type === "error";
}

export async function readChatNdjsonStream(
  response: Response,
  onEvent: (event: ChatStreamEvent) => void
): Promise<void> {
  if (!response.body) {
    throw new ChatStreamRequestError("Пустой ответ сервера", response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!isChatStreamEvent(parsed)) {
      return;
    }

    onEvent(parsed);

    if (parsed.type === "error") {
      throw new ChatStreamRequestError(parsed.error, 500, { error: parsed.error });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(line);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      consumeLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function fetchChatNdjsonStream(url: string, body: unknown): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const contentType = response.headers.get("content-type") ?? "";
  const isStream = contentType.includes("ndjson") || contentType.includes("event-stream");

  if (!isStream) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ChatStreamRequestError(
      payload.error || "Не удалось отправить сообщение",
      response.status,
      payload
    );
  }

  return response;
}

export async function fetchAndReadChatStream(
  url: string,
  body: unknown,
  handlers: {
    onMeta?: (event: ChatStreamMetaEvent) => void;
    onDelta?: (text: string) => void;
    onEnd?: (event: ChatStreamEndEvent) => void;
  } = {}
): Promise<ChatStreamEndEvent | null> {
  const response = await fetchChatNdjsonStream(url, body);
  let endEvent: ChatStreamEndEvent | null = null;

  await readChatNdjsonStream(response, (event) => {
    if (event.type === "meta") {
      handlers.onMeta?.(event);
    } else if (event.type === "delta") {
      handlers.onDelta?.(event.text);
    } else if (event.type === "end") {
      endEvent = event;
      handlers.onEnd?.(event);
    }
  });

  return endEvent;
}
