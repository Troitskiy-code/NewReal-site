// Routing is decided on the server from the validated reference, never modelId.
export const KIE_CREDIT_RUB = 0.5;
export const KIE_TEXT_MODEL = { id: "seedream/5-flash-text-to-image", name: "Seedream 5.0 Flash", estimatedCredits: 3.24 } as const;
export const KIE_REFERENCE_MODEL = { id: "nano-banana-2-1", name: "Nano Banana 2.1", estimatedCredits: 4 } as const;
/**
 * An "uncertain" job (create response lost or unreadable) blocks new paid runs only for this long:
 * enough for a task created behind that response to finish, so a quick retry cannot pay twice.
 * Earlier it blocked the user indefinitely. Its reserved quota is not refunded.
 */
export const UNCERTAIN_BLOCK_MS = 5 * 60 * 1000;
export function uncertainJobBlocks(job: { state: string; updatedAt: Date }, now = Date.now()) {
  return job.state === "uncertain" && now - job.updatedAt.getTime() < UNCERTAIN_BLOCK_MS;
}
/** Whole seconds until an uncertain job stops blocking new runs (0 when it no longer blocks). */
export function uncertainBlockSecondsLeft(job: { updatedAt: Date }, now = Date.now()) {
  // Capped at the window: updatedAt can run a few ms ahead of this clock, which showed "6 min" for a 5-minute block.
  const seconds = Math.ceil((job.updatedAt.getTime() + UNCERTAIN_BLOCK_MS - now) / 1000);
  return Math.min(UNCERTAIN_BLOCK_MS / 1000, Math.max(0, seconds));
}
export function kieAvatarModel(hasReference: boolean) {
  return hasReference ? KIE_REFERENCE_MODEL : KIE_TEXT_MODEL;
}
export function kieAvatarInput(prompt: string, referenceUrl?: string) {
  return referenceUrl
    ? { prompt, image_input: [referenceUrl], aspect_ratio: "3:4", resolution: "1K", output_format: "png" }
    : { prompt, aspect_ratio: "3:4", size: "1K", output_format: "png", nsfw_checker: true };
}
