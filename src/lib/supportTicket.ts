export const SUPPORT_TOPICS = ["payment", "technical", "refund", "moderation", "other"] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MESSAGE = 4000;
const MIN_MESSAGE = 10;

export type SupportTicketInput = {
  topic: unknown;
  email: unknown;
  message: unknown;
};

export type ParsedSupportTicket =
  | { ok: true; topic: SupportTopic; email: string; message: string }
  | { ok: false; error: "invalid_topic" | "invalid_email" | "invalid_message" };

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

  return { ok: true, topic: topic as SupportTopic, email, message };
}
