export const SUPPORT_TOPICS = ["payment", "technical", "refund", "moderation", "other"] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MESSAGE = 4000;
const MIN_MESSAGE = 10;
export const SUPPORT_REFERENCE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;

export type SupportTicketInput = {
  topic: unknown;
  email: unknown;
  message: unknown;
  referenceTicketId?: unknown;
};

export type ParsedSupportTicket =
  | { ok: true; topic: SupportTopic; email: string; message: string; referenceTicketId?: string }
  | { ok: false; error: "invalid_topic" | "invalid_email" | "invalid_message" | "invalid_reference" };

export function parseSupportTicket(input: SupportTicketInput): ParsedSupportTicket {
  const topic = typeof input.topic === "string" ? input.topic.trim() : "";
  if (!SUPPORT_TOPICS.includes(topic as SupportTopic)) {
    return { ok: false, error: "invalid_topic" };
  }

  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { ok: false, error: "invalid_email" };
  }

  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (message.length < MIN_MESSAGE || message.length > MAX_MESSAGE) {
    return { ok: false, error: "invalid_message" };
  }

  const referenceTicketId = typeof input.referenceTicketId === "string" ? input.referenceTicketId.trim() : "";
  if ((input.referenceTicketId != null && typeof input.referenceTicketId !== "string") ||
      (referenceTicketId && !SUPPORT_REFERENCE_RE.test(referenceTicketId))) {
    return { ok: false, error: "invalid_reference" };
  }

  return { ok: true, topic: topic as SupportTopic, email, message,
    ...(referenceTicketId ? { referenceTicketId } : {}) };
}

export function supportMessageWithReference(ticket: Extract<ParsedSupportTicket, { ok: true }>): string {
  // This is a user-supplied reference, not proof of ownership or a thread merge.
  return ticket.referenceTicketId
    ? `Предыдущее обращение (номер указан пользователем): ${ticket.referenceTicketId}\n\n${ticket.message}`
    : ticket.message;
}
