import axios from "axios";
import { createRequire } from "node:module";
import { Jimp } from "jimp";

const DEFAULT_API_URL = "https://api.createya.ai";

export const CREATEYA_TEXT_MODEL = "grok-imagine-t2i";
export const CREATEYA_IMAGE_MODEL = "grok-imagine-i2i";
export const MISSING_RUN_ID_MESSAGE = "Не удалось запустить генерацию. Попробуйте ещё раз.";

const PENDING_STATUSES = new Set([
  "queued",
  "processing",
  "in_progress",
  "pending",
  "running",
  "started",
  "submitted",
]);

type CreateyaErrorBody = {
  error?: { code?: string; message?: string };
  code?: string;
  message?: string;
};

type CreateyaRunResult = CreateyaErrorBody & {
  id?: string;
  run_id?: string;
  runId?: string;
  status?: string;
  output?: { url?: string; urls?: string[] };
  url?: string;
  urls?: string[];
  data?: CreateyaRunResult;
};

type CreateyaUploadResult = {
  url?: string;
  urls?: string[];
  data?: { url?: string };
};

function getConfig() {
  const apiKey = process.env.CREATEYA_API_KEY ?? "";
  const apiUrl = (process.env.CREATEYA_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
  return { apiKey, apiUrl };
}

function authHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readErrorField(data: unknown, key: "code" | "message"): string | undefined {
  const record = asRecord(data);
  if (!record) return undefined;
  const nested = asRecord(record.error);
  const value = nested?.[key] ?? record[key];
  return asString(value);
}

function formatCreateyaError(status: number | undefined, data: unknown): string {
  const code = readErrorField(data, "code");
  const message = readErrorField(data, "message");
  if (code === "insufficient_credits" || status === 402) {
    return "Сервис генерации временно недоступен (недостаточно кредитов провайдера).";
  }
  if (code === "model_safety_violation") {
    return "sensitive";
  }
  if (status === 401) {
    return "CREATEYA_API_KEY не настроен или недействителен";
  }
  if (message && /mime_type|not allowed/i.test(message)) {
    return "Референс должен быть в формате PNG или JPEG. Загрузите другое изображение.";
  }
  if (message) return message;
  if (status) return `Createya вернула ошибку HTTP ${status}`;
  return "Не удалось сгенерировать аватар";
}

function createyaErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return formatCreateyaError(error.response?.status, error.response?.data);
  }
  if (error instanceof Error) return error.message;
  return "Не удалось сгенерировать аватар";
}

function parseDataUrl(value: string): { mime: string; buffer: Buffer } | null {
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
}

const nodeRequire = createRequire(import.meta.url);

type HeifImage = {
  get_width: () => number;
  get_height: () => number;
  display: (
    imageData: { data: Uint8ClampedArray; width: number; height: number },
    callback: (displayData: { data: Uint8ClampedArray; width: number; height: number } | null) => void
  ) => void;
  free: () => void;
};

type LibHeif = {
  ready?: Promise<unknown>;
  HeifDecoder: new () => {
    decode: (buffer: Uint8Array) => HeifImage[];
    decoder: { delete: () => void };
  };
};

async function decodeHeifFamily(buffer: Buffer) {
  const libheif = nodeRequire("libheif-js") as LibHeif;
  if (libheif.ready) await libheif.ready;

  const bytes = Uint8Array.from(buffer);
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images.length) {
    throw new Error("HEIF image not found");
  }

  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();

  try {
    const displayData = await new Promise<{ data: Uint8ClampedArray; width: number; height: number }>(
      (resolve, reject) => {
        image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (result) => {
          if (!result) reject(new Error("HEIF processing error"));
          else resolve(result);
        });
      }
    );

    return Jimp.fromBitmap({
      data: Buffer.from(displayData.data),
      width: displayData.width,
      height: displayData.height,
    });
  } finally {
    for (const item of images) {
      try {
        item.free();
      } catch {
        // ignore cleanup errors
      }
    }
    try {
      decoder.decoder.delete();
    } catch {
      // ignore cleanup errors
    }
  }
}

async function readImageFallbacks(buffer: Buffer) {
  const brand = buffer.subarray(8, 12).toString("ascii").replace(/\0/g, " ").trim();
  console.log("[convertImageToPNG] heif/avif brand:", brand || "(none)");

  // AVIF is converted to PNG in the browser before upload.
  if (brand === "avif" || brand === "avis") {
    console.error("[convertImageToPNG] AVIF reached server; expected client-side PNG");
    throw new Error("AVIF нужно конвертировать в PNG до отправки");
  }

  console.log("[convertImageToPNG] trying HEIC/HEIF fallback");
  return decodeHeifFamily(buffer);
}

export async function convertImageToPNG(imageData: string): Promise<string> {
  console.log("[convertImageToPNG] input type:", typeof imageData);
  console.log("[convertImageToPNG] input preview:", typeof imageData === "string" ? imageData.slice(0, 100) : String(imageData));
  console.log("[convertImageToPNG] input length:", typeof imageData === "string" ? imageData.length : 0);

  if (!imageData) return imageData;

  try {
    let buffer: Buffer;

    if (imageData.startsWith("data:image/") || imageData.startsWith("data:")) {
      const mimeMatch = imageData.match(/^data:([^;]+)/);
      console.log("[convertImageToPNG] mime type:", mimeMatch ? mimeMatch[1] : "unknown");

      const commaIndex = imageData.indexOf(",");
      if (commaIndex === -1) {
        console.error("[convertImageToPNG] invalid data URL: missing comma separator");
        throw new Error("Invalid base64 data: missing comma separator");
      }

      const base64 = imageData.slice(commaIndex + 1);
      console.log("[convertImageToPNG] base64 length:", base64.length);
      buffer = Buffer.from(base64, "base64");
    } else if (imageData.startsWith("http://") || imageData.startsWith("https://")) {
      console.log("[convertImageToPNG] fetching URL:", imageData);
      console.log("[convertImageToPNG] Fetching URL...");
      let response: Response;
      try {
        response = await fetch(imageData);
      } catch (fetchError) {
        console.error("[convertImageToPNG] fetch threw:", fetchError);
        if (fetchError instanceof Error) {
          console.error("[convertImageToPNG] fetch message:", fetchError.message);
          console.error("[convertImageToPNG] fetch stack:", fetchError.stack);
        }
        throw new Error(`Failed to fetch image: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
      }

      console.log("[convertImageToPNG] Response status:", response.status);
      console.log("[convertImageToPNG] Content-Type:", response.headers.get("content-type"));
      if (!response.ok) {
        console.error("[convertImageToPNG] fetch failed:", response.status, response.statusText);
        throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
      }
      buffer = Buffer.from(await response.arrayBuffer());
    } else {
      console.log("[convertImageToPNG] assuming raw base64");
      buffer = Buffer.from(imageData, "base64");
    }

    console.log("[convertImageToPNG] buffer size:", buffer.length);

    let image;
    try {
      image = await Jimp.read(Buffer.from(buffer));
      const width = image.bitmap?.width ?? image.width;
      const height = image.bitmap?.height ?? image.height;
      console.log("[convertImageToPNG] Jimp read successful, image width/height:", `${width}x${height}`);
    } catch (jimpError) {
      console.error("[convertImageToPNG] Jimp.read failed:", jimpError);
      if (jimpError instanceof Error) {
        console.error("[convertImageToPNG] Jimp.read message:", jimpError.message);
        console.error("[convertImageToPNG] Jimp.read stack:", jimpError.stack);
      }
      try {
        image = await readImageFallbacks(buffer);
        const width = image.bitmap?.width ?? image.width;
        const height = image.bitmap?.height ?? image.height;
        console.log("[convertImageToPNG] fallback read successful, image width/height:", `${width}x${height}`);
      } catch (fallbackError) {
        console.error("[convertImageToPNG] fallback decode failed:", fallbackError);
        if (fallbackError instanceof Error) {
          console.error("[convertImageToPNG] fallback message:", fallbackError.message);
          console.error("[convertImageToPNG] fallback stack:", fallbackError.stack);
        }
        throw fallbackError;
      }
    }

    const pngBuffer = Buffer.from(await image.getBuffer("image/png"));
    console.log("[convertImageToPNG] PNG buffer size:", pngBuffer.length);

    const result = `data:image/png;base64,${pngBuffer.toString("base64")}`;
    console.log("[convertImageToPNG] conversion successful, result length:", result.length);
    return result;
  } catch (error) {
    console.error("[convertImageToPNG] failed:", error);
    if (error instanceof Error) {
      console.error("[convertImageToPNG] failed message:", error.message);
      console.error("[convertImageToPNG] failed stack:", error.stack);
    }
    throw new Error(
      `Не удалось прочитать референс-изображение: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function extractRunId(data: unknown): string | undefined {
  const record = asRecord(data);
  if (!record) return undefined;
  const nested = asRecord(record.data);
  return (
    asString(record.run_id) ||
    asString(record.runId) ||
    asString(record.id) ||
    asString(nested?.run_id) ||
    asString(nested?.runId) ||
    asString(nested?.id)
  );
}

function extractOutputUrl(data: unknown): string | undefined {
  const record = asRecord(data);
  if (!record) return undefined;
  const output = asRecord(record.output);
  const nested = asRecord(record.data);
  const nestedOutput = asRecord(nested?.output);
  const urls = [output?.urls, nestedOutput?.urls, record.urls, nested?.urls];
  for (const value of urls) {
    if (Array.isArray(value)) {
      const url = value.find((item) => asString(item));
      if (url) return String(url);
    }
  }
  return (
    asString(output?.url) ||
    asString(nestedOutput?.url) ||
    asString(record.url) ||
    asString(nested?.url)
  );
}

async function uploadReferenceImage(
  apiUrl: string,
  apiKey: string,
  referenceImage: string
): Promise<string> {
  const prepared = await convertImageToPNG(referenceImage);
  if (prepared.startsWith("http://") || prepared.startsWith("https://")) {
    return prepared;
  }

  const parsed = parseDataUrl(prepared);
  if (!parsed) {
    throw new Error("Референс должен быть URL или data URL");
  }

  const form = new FormData();
  const blob = new Blob([new Uint8Array(parsed.buffer)], { type: parsed.mime || "image/png" });
  const ext = parsed.mime.includes("png") ? "png" : parsed.mime.includes("webp") ? "webp" : "jpg";
  form.append("file", blob, `reference.${ext}`);

  const { data, status } = await axios.post<CreateyaUploadResult>(`${apiUrl}/v1/uploads`, form, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 60_000,
    validateStatus: () => true,
  });

  if (status >= 400) {
    throw new Error(formatCreateyaError(status, data));
  }

  const url = data.url || data.urls?.find(Boolean) || data.data?.url;
  if (!url) {
    console.error("[Createya] upload response without url", { status, data });
    throw new Error("Createya не вернула URL загруженного изображения");
  }
  return url;
}

function throwIfFailed(result: CreateyaRunResult) {
  if (result.status !== "failed") return;
  throw new Error(formatCreateyaError(undefined, result) || "Генерация отклонена");
}

async function pollRun(
  apiUrl: string,
  apiKey: string,
  runId: string,
  timeoutMs = 90_000
): Promise<CreateyaRunResult> {
  const started = Date.now();
  let delay = 2_000;

  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const { data, status } = await axios.get<CreateyaRunResult>(`${apiUrl}/v1/runs/${runId}`, {
      headers: authHeaders(apiKey),
      timeout: 30_000,
      validateStatus: () => true,
    });

    console.info("[Createya] poll", { runId, httpStatus: status, body: data });

    if (status >= 400) {
      throw new Error(formatCreateyaError(status, data));
    }
    if (data.status === "completed") return data;
    const doneUrl = extractOutputUrl(data);
    if (doneUrl && data.status !== "failed") {
      return { ...data, output: { url: doneUrl, urls: [doneUrl] } };
    }
    if (data.status === "failed") {
      throwIfFailed(data);
      throw new Error("Генерация отклонена");
    }
    delay = Math.min(delay * 1.5, 8_000);
  }

  throw new Error("Превышено время ожидания генерации");
}

export async function generateWithCreateya(
  prompt: string,
  referenceImage?: string,
  modelType?: "FLUX" | "SD"
): Promise<string> {
  const { apiKey, apiUrl } = getConfig();
  if (!apiKey) {
    throw new Error("CREATEYA_API_KEY не настроен");
  }

  const hasReference = Boolean(referenceImage) || modelType === "SD";
  const model = hasReference ? CREATEYA_IMAGE_MODEL : CREATEYA_TEXT_MODEL;
  const input: Record<string, unknown> = {
    prompt,
    num_images: 1,
    output_format: "webp",
  };

  if (!hasReference) {
    input.aspect_ratio = "3:4";
  } else if (referenceImage) {
    const uploadedUrl = await uploadReferenceImage(apiUrl, apiKey, referenceImage);
    input.image_url = uploadedUrl;
    input.image_urls = [uploadedUrl];
  } else {
    throw new Error("Для генерации с референсом нужно изображение");
  }

  const runUrl = `${apiUrl}/v1/run`;
  console.info("[Createya] request", {
    method: "POST",
    url: runUrl,
    headers: { Authorization: "Bearer ***", "Content-Type": "application/json" },
    model,
    hasReference,
    input: {
      ...input,
      prompt: `[${prompt.length} chars]`,
      image_url: input.image_url ? "[set]" : undefined,
      image_urls: input.image_urls ? "[set]" : undefined,
    },
  });

  try {
    const { data, status } = await axios.post<CreateyaRunResult>(
      runUrl,
      { model, input },
      { headers: authHeaders(apiKey), timeout: 60_000, validateStatus: () => true }
    );

    console.info("[Createya] response", { httpStatus: status, body: data });

    if (status >= 400) {
      throw new Error(formatCreateyaError(status, data));
    }

    throwIfFailed(data);

    const outputUrl = extractOutputUrl(data);
    const runId = extractRunId(data);
    const isPending =
      status === 202 ||
      PENDING_STATUSES.has(data.status || "") ||
      (!outputUrl && Boolean(runId));

    if (data.status === "completed" && outputUrl) {
      return outputUrl;
    }

    if (isPending) {
      if (!runId) {
        console.error("[Createya] missing run id", JSON.stringify(data));
        throw new Error(MISSING_RUN_ID_MESSAGE);
      }
      const completed = await pollRun(apiUrl, apiKey, runId);
      const completedUrl = extractOutputUrl(completed);
      if (!completedUrl) {
        console.error("[Createya] completed without image url", JSON.stringify(completed));
        throw new Error("Createya не вернула URL изображения");
      }
      return completedUrl;
    }

    if (outputUrl) return outputUrl;

    console.error("[Createya] unexpected run payload", JSON.stringify(data));
    throw new Error(MISSING_RUN_ID_MESSAGE);
  } catch (error) {
    throw new Error(createyaErrorMessage(error));
  }
}

export async function imageUrlToDataUrl(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith("data:")) return imageUrl;
  const response = await axios.get<ArrayBuffer>(imageUrl, {
    responseType: "arraybuffer",
    timeout: 60_000,
  });
  const mime = String(response.headers["content-type"] || "image/webp").split(";")[0];
  const base64 = Buffer.from(response.data).toString("base64");
  return `data:${mime};base64,${base64}`;
}
