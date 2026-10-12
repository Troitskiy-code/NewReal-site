// Client-safe story helpers (no database imports): URL parameter, summary type, display title.

/** Query parameter carrying the selected story, for pages and for /api/chat/[id]/* requests. */
export const THREAD_QUERY_PARAM = "thread";

export type ChatThreadStatus = "active" | "archived";

export type ChatThreadSummary = {
  id: string;
  number: number;
  title: string | null;
  status: ChatThreadStatus;
  createdAt: string;
  lastMessageAt: string;
  messageCount?: number;
};

/** Adds ?thread= to an API or page URL; without a story the URL is unchanged (default story). */
export function withThread(url: string, threadId?: string | null): string {
  if (!threadId) return url;
  const [path, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  params.set(THREAD_QUERY_PARAM, threadId);
  return `${path}?${params.toString()}`;
}

/** Custom title, or the automatic "Story N" from the caller's translation. */
export function threadDisplayTitle(
  thread: Pick<ChatThreadSummary, "title" | "number">,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  return thread.title?.trim() || t("chatThreads.defaultTitle", { number: thread.number });
}
