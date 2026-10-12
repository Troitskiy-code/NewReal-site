import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import sharp from "sharp";
import { isSafeAvatarReference } from "./avatarReference";
import { kieAvatarInput, kieAvatarModel } from "./kieAvatarModels";

const API = "https://api.kie.ai";
const UPLOAD = "https://kieai.redpandaai.co";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export class KieError extends Error {
  readonly code: string;
  readonly rejected: boolean;
  constructor(code: string, rejected = false) {
    super("Image service request failed");
    this.name = "KieError";
    this.code = code;
    this.rejected = rejected;
  }
}
export function hasKieKey() { return Boolean(process.env['KIE_API_KEY']?.trim()); }
function headers() {
  const key = process.env['KIE_API_KEY']?.trim();
  if (!key) throw new KieError("unavailable", true);
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function isKieTaskId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
function failureCode(body: Record<string, unknown>, code: number) {
  // Provider text is inspected only for classification and is never returned or logged.
  const message = typeof body.msg === "string" ? body.msg : "";
  return /nsfw|sensitive|safety|content policy|moderation/i.test(message) ? "safety"
    : [401, 402, 403, 429, 455].includes(code) ? "unavailable" : "provider_error";
}
async function request(url: string, body?: unknown) {
  let response: Response;
  try {
    response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000), redirect: "error", cache: "no-store" });
  } catch (error) {
    if (error instanceof KieError) throw error;
    throw new KieError("connection");
  }
  let data: Record<string, unknown>;
  try { data = record(await response.json()); } catch { throw new KieError("invalid_response"); }
  const code = typeof data.code === "number" ? data.code : response.status;
  if (!response.ok || data.code !== 200) {
    const category = failureCode(data, code);
    // Kie returns HTTP 200 with an error code in the body when it refuses a request (including
    // 500/501 for moderated content): that is a definite "no task was created". Only HTTP 5xx
    // responses stay uncertain, since a paid task may exist. A content-policy refusal is never billed.
    const definite = response.ok
      || (response.status < 500 && [400, 401, 402, 403, 404, 422, 429, 455, 505].includes(code))
      || category === "safety";
    throw new KieError(category, definite);
  }
  return data;
}
// Phone cameras shoot 24–50 MP; the input is capped at 5 MB, so this only guards against decompression bombs.
const MAX_REFERENCE_PIXELS = 64_000_000;
export async function prepareKieReference(value: string) {
  if (!isSafeAvatarReference(value)) throw new KieError("invalid_reference", true);
  try {
    const buffer = Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
    // WebP keeps photos near 1 MB at 1536 px; PNG often exceeded the cap and slowed the upload.
    const webp = await sharp(buffer, { limitInputPixels: MAX_REFERENCE_PIXELS, animated: false })
      .rotate().resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
    if (webp.length > 5 * 1024 * 1024) throw new Error("too large");
    return `data:image/webp;base64,${webp.toString("base64")}`;
  } catch { throw new KieError("invalid_reference", true); }
}
export async function uploadKieReference(base64Data: string) {
  const data = await request(`${UPLOAD}/api/file-base64-upload`, {
    base64Data, uploadPath: "newverse/references", fileName: `${randomUUID()}.webp`,
  });
  const url = record(data.data).downloadUrl;
  if (typeof url !== "string" || !isKieImageUrl(url)) throw new KieError("invalid_response");
  return url;
}
export function kieCallbackUrl() {
  if (!process.env['KIE_WEBHOOK_HMAC_KEY']) return undefined;
  try {
    const base = new URL(process.env['NEXTAUTH_URL'] ?? "");
    if (base.protocol !== "https:") return undefined;
    return new URL("/api/webhook/kie", base.origin).href;
  } catch { return undefined; }
}
export async function createKieAvatar(prompt: string, referenceUrl?: string) {
  const data = await request(`${API}/api/v1/jobs/createTask`, {
    model: kieAvatarModel(Boolean(referenceUrl)).id, input: kieAvatarInput(prompt, referenceUrl), callBackUrl: kieCallbackUrl(),
  });
  const taskId = record(data.data).taskId;
  if (!isKieTaskId(taskId)) throw new KieError("invalid_response");
  return taskId;
}
export type KieTask = { taskId: string; model: string; state: string; imageUrl: string | null; credits: number | null; errorCode: string | null };
export async function getKieAvatarTask(taskId: string): Promise<KieTask> {
  if (!isKieTaskId(taskId)) throw new KieError("invalid_task");
  const body = await request(`${API}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
  const data = record(body.data);
  if (data.taskId !== taskId || typeof data.model !== "string"
    || !["waiting", "queuing", "generating", "success", "fail"].includes(String(data.state))) throw new KieError("invalid_response");
  let imageUrl: string | null = null;
  if (data.state === "success") {
    try {
      const results = record(JSON.parse(String(data.resultJson))).resultUrls;
      if (Array.isArray(results) && typeof results[0] === "string" && isKieImageUrl(results[0])) imageUrl = results[0];
    } catch { /* keep successful paid task retryable until an image can be saved */ }
  }
  const credits = typeof data.creditsConsumed === "number" && Number.isFinite(data.creditsConsumed) && data.creditsConsumed >= 0 ? data.creditsConsumed : null;
  return { taskId, model: data.model, state: String(data.state), imageUrl, credits,
    errorCode: data.state === "fail" ? failureCode({ msg: data.failMsg }, Number(data.failCode)) : null };
}
// Only provider-owned image hosts; no credentials, arbitrary URLs, redirects or private IP fetches.
export function isKieImageUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && ["redpandaai.co", "kie.ai", "aiquickdraw.com"].some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}
export async function saveKieImage(value: string) {
  if (!isKieImageUrl(value)) throw new KieError("invalid_image");
  const response = await fetch(value, { signal: AbortSignal.timeout(20_000), redirect: "error", cache: "no-store" });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new KieError("invalid_image");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > MAX_IMAGE_BYTES) throw new KieError("invalid_image");
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const image = await sharp(Buffer.concat(chunks), { limitInputPixels: 16_000_000, animated: false })
    .rotate().resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
  return `data:image/webp;base64,${image.toString("base64")}`;
}
export function verifyKieWebhook(taskId: unknown, timestamp: string | null, signature: string | null, now = Date.now()) {
  const key = process.env['KIE_WEBHOOK_HMAC_KEY'];
  if (!key || !isKieTaskId(taskId) || !timestamp || !/^\d{10}$/.test(timestamp) || !signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)
    || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", key).update(`${taskId}.${timestamp}`).digest("base64");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
