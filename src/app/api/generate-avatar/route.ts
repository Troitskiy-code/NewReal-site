import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import Replicate from "replicate";
import { authOptions } from "@/lib/auth";

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
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildPrompt(body: GenerateAvatarBody): string {
  const name = asText(body.name) || "unnamed character";
  const appearance = asText(body.appearance);
  const description = asText(body.description);
  const scenario = asText(body.scenario);
  const exampleDialogs = asText(body.exampleDialogs);

  const parts = [
    `Portrait of ${name}`,
    appearance,
    description,
    scenario,
    exampleDialogs,
    "fantasy style, detailed, high quality, character art",
  ].filter(Boolean);

  return parts.join(", ");
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

    const prompt = buildPrompt(body);
    const referenceImage = asText(body.referenceImage);
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
    return NextResponse.json({ imageUrl });
  } catch (error) {
    console.error("Avatar generation error:", error);
    const message = error instanceof Error ? error.message : "Не удалось сгенерировать аватар";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
