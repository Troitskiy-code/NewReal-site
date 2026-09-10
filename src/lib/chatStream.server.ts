import { encodeChatStreamEvent, type ChatStreamEvent } from "@/lib/chatStream";
import { getLogUserId, runWithLogUser } from "@/lib/logger";

export function createChatNdjsonResponse(
  run: (emit: (event: ChatStreamEvent) => void) => Promise<void>
): Response {
  const logUserId = getLogUserId();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatStreamEvent) => {
        controller.enqueue(encodeChatStreamEvent(event));
      };

      const execute = () => run(emit);

      try {
        await (logUserId ? runWithLogUser(logUserId, execute) : execute());
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
