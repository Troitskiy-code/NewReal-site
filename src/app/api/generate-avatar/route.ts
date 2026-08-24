import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import Replicate from "replicate";
import { authOptions } from "@/lib/auth";
import {
  canSpendFreeToken,
  chargeAvatarVC,
  getPaidVCCost,
  replenishAvatarTokens,
  spendFreeToken,
  type AvatarModelType,
} from "@/lib/avatarTokens";
import { buildAvatarPrompt, isSensitiveGenerationError, SENSITIVE_CLIENT_MESSAGE } from "@/lib/avatarPrompt";

export const maxDuration = 60;

const TEXT_TO_IMAGE_MODEL = "black-forest-labs/flux-schnell";
const IMAGE_TO_IMAGE_MODEL = "stability-ai/stable-diffusion-3.5-large";

type GenerateAvatarBody = {
  name?: unknown;
  appearance?: unknown;
  description?: unknown;
  scenario?: unknown;
  exampleDialogs?: unknown;
  referenceImage?: unknown;
  paymentMethod?: unknown;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function readErrorDetails(error: unknown): Promise<string> {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    if (error.stack) parts.push(error.stack);
  } else {
    parts.push(String(error));
  }

  const response = (error as { response?: Response }).response;
  if (response) {
    try {
      parts.push(await response.clone().text());
    } catch {
      // ignore
    }
  }

  return parts.join("\n");
}

function firstOutput(output: unknown): unknown {
  if (Array.isArray(output)) {
    return output.find((item) => item != null) ?? null;
  }
  return output;
}

async function outputToDataUrl(output: unknown): Promise<string> {
  const first = firstOutput(output);
  if (!first) {
    throw new Error("Пустой ответ генерации");
  }

  if (typeof first === "object" && first !== null && "blob" in first && typeof first.blob === "function") {
    const blob = await first.blob();
    const buffer = Buffer.from(await blob.arrayBuffer());
    const mime = blob.type || "image/webp";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  }

  let imageUrl: string | null = null;
  if (typeof first === "string") {
    imageUrl = first;
  } else if (first instanceof URL) {
    imageUrl = first.href;
  } else if (typeof first === "object" && first !== null) {
    const maybe = first as { url?: unknown; href?: unknown };
    if (typeof maybe.href === "string") imageUrl = maybe.href;
    else if (typeof maybe.url === "function") {
      const resolved = maybe.url();
      imageUrl = resolved instanceof URL ? resolved.href : String(resolved);
    } else if (typeof maybe.url === "string") {
      imageUrl = maybe.url;
    }
  }

  if (!imageUrl) {
    throw new Error("Не удалось получить URL изображения");
  }

  if (imageUrl.startsWith("data:")) return imageUrl;

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error("Не удалось скачать сгенерированное изображение");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const mime = response.headers.get("content-type") || "image/webp";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const apiKey = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_TOKEN;
    if (!apiKey) {
      return NextResponse.json({ error: "REPLICATE_API_KEY не настроен" }, { status: 500 });
    }

    const body = (await req.json()) as GenerateAvatarBody;
    const name = asText(body.name);
    if (!name) {
      return NextResponse.json({ error: "Укажите имя персонажа" }, { status: 400 });
    }

    const paymentMethod = asText(body.paymentMethod) === "paid" ? "paid" : "free";
    const prompt = buildAvatarPrompt(body);
    const referenceImage = asText(body.referenceImage);
    const modelType: AvatarModelType = referenceImage ? "SD" : "FLUX";

    let user = await replenishAvatarTokens(session.user.id);

    if (paymentMethod === "free") {
      const canSpend = canSpendFreeToken(user, modelType);
      if (!canSpend.ok) {
        return NextResponse.json(
          { error: canSpend.reason || "Недостаточно AT" },
          { status: 402 }
        );
      }
    } else {
      const costVC = getPaidVCCost(modelType);
      if (user.verseCoins < costVC) {
        return NextResponse.json(
          {
            error: "Недостаточно VC",
            requiredVC: costVC,
            remainingVC: user.verseCoins,
          },
          { status: 402 }
        );
      }
    }

    const replicate = new Replicate({ auth: apiKey });
    const output = referenceImage
      ? await replicate.run(IMAGE_TO_IMAGE_MODEL, {
          input: {
            prompt,
            image: referenceImage,
            prompt_strength: 0.72,
            output_format: "webp",
          },
        })
      : await replicate.run(TEXT_TO_IMAGE_MODEL, {
          input: {
            prompt,
            aspect_ratio: "3:4",
            output_format: "webp",
            output_quality: 90,
            go_fast: true,
            num_outputs: 1,
          },
        });

    const imageUrl = await outputToDataUrl(output);

    let remainingTokens = user.avatarTokens;
    let remainingVC = user.verseCoins;

    if (paymentMethod === "free") {
      user = await spendFreeToken(user, modelType);
      remainingTokens = user.avatarTokens;
      remainingVC = user.verseCoins;
    } else {
      remainingVC = await chargeAvatarVC(user.id, getPaidVCCost(modelType), modelType);
      remainingTokens = user.avatarTokens;
    }

    return NextResponse.json({
      imageUrl,
      used: paymentMethod,
      remainingTokens,
      remainingVC,
    });
  } catch (error) {
    const details = await readErrorDetails(error);
    console.error("Avatar generation error:", details);

    if (isSensitiveGenerationError(error, details)) {
      return NextResponse.json({ error: SENSITIVE_CLIENT_MESSAGE }, { status: 400 });
    }

    return NextResponse.json({ error: "Не удалось сгенерировать аватар" }, { status: 500 });
  }
}
