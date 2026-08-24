import axios from "axios";

const DEFAULT_API_URL = "https://api.createya.ai";

export const CREATEYA_TEXT_MODEL = "grok-imagine-t2i";
export const CREATEYA_IMAGE_MODEL = "grok-imagine-i2i";

type CreateyaErrorBody = {
  error?: { code?: string; message?: string };
  code?: string;
  message?: string;
};

type CreateyaRunResult = CreateyaErrorBody & {
  run_id?: string;
  status?: string;
  output?: { url?: string; urls?: string[] };
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

function readErrorField(data: unknown, key: "code" | "message"): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : undefined;
  const value = nested?.[key] ?? record[key];
  return typeof value === "string" && value ? value : undefined;
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

async function uploadReferenceImage(
  apiUrl: string,
  apiKey: string,
  referenceImage: string
): Promise<string> {
  if (referenceImage.startsWith("http://") || referenceImage.startsWith("https://")) {
    return referenceImage;
  }

  const parsed = parseDataUrl(referenceImage);
  if (!parsed) {
    throw new Error("Референс должен быть URL или data URL");
  }

  const form = new FormData();
  const blob = new Blob([new Uint8Array(parsed.buffer)], { type: parsed.mime });
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
    throw new Error("Createya не вернула URL загруженного изображения");
  }
  return url;
}

function extractOutputUrl(result: CreateyaRunResult): string {
  const url = result.output?.urls?.find(Boolean) || result.output?.url;
  if (!url) {
    throw new Error("Createya не вернула URL изображения");
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

    if (status >= 400) {
      throw new Error(formatCreateyaError(status, data));
    }
    if (data.status === "completed") return data;
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

  try {
    const { data, status } = await axios.post<CreateyaRunResult>(
      `${apiUrl}/v1/run`,
      { model, input },
      { headers: authHeaders(apiKey), timeout: 60_000, validateStatus: () => true }
    );

    if (status >= 400) {
      throw new Error(formatCreateyaError(status, data));
    }

    throwIfFailed(data);

    if (data.status === "completed") {
      return extractOutputUrl(data);
    }

    if (status === 202 || data.status === "queued" || data.status === "processing" || data.status === "in_progress") {
      if (!data.run_id) {
        throw new Error("Createya не вернула run_id");
      }
      const completed = await pollRun(apiUrl, apiKey, data.run_id);
      return extractOutputUrl(completed);
    }

    return extractOutputUrl(data);
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
