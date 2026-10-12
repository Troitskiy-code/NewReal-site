// Routing is decided on the server from the validated reference, never modelId.
export const KIE_CREDIT_RUB = 0.5;
export const KIE_TEXT_MODEL = { id: "seedream/5-flash-text-to-image", name: "Seedream 5.0 Flash", estimatedCredits: 3.24 } as const;
export const KIE_REFERENCE_MODEL = { id: "nano-banana-2-1", name: "Nano Banana 2.1", estimatedCredits: 4 } as const;
/**
 * An "uncertain" job (create response lost) blocks new paid runs only for this long. Earlier it
 * blocked the user indefinitely, with no support tool to clear it. Its reserved quota is not refunded.
 */
export const UNCERTAIN_BLOCK_MS = 15 * 60 * 1000;
export function uncertainJobBlocks(job: { state: string; updatedAt: Date }, now = Date.now()) {
  return job.state === "uncertain" && now - job.updatedAt.getTime() < UNCERTAIN_BLOCK_MS;
}
export function kieAvatarModel(hasReference: boolean) {
  return hasReference ? KIE_REFERENCE_MODEL : KIE_TEXT_MODEL;
}
export function kieAvatarInput(prompt: string, referenceUrl?: string) {
  return referenceUrl
    ? { prompt, image_input: [referenceUrl], aspect_ratio: "3:4", resolution: "1K", output_format: "png" }
    : { prompt, aspect_ratio: "3:4", size: "1K", output_format: "png", nsfw_checker: true };
}
