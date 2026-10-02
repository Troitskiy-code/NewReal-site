export const SUPPORT_DRAFT_KEY = "nv-support-draft";
export const SUPPORT_KEY_RE = /^[a-zA-Z0-9_-]{8,128}$/;
export function newSupportClientKey(): string {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, "")
    ?? `sup${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}
export function supportSubmissionPayload(topic: string, email: string, message: string): string {
  return JSON.stringify({ topic, email: email.trim().toLowerCase(), message: message.trim() });
}
export function supportSubmissionKey(clientKey: string, previousPayload: string | null, payload: string): string {
  return previousPayload === null || previousPayload === payload ? clientKey : newSupportClientKey();
}
