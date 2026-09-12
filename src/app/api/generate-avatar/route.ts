import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  canGenerateThisMonth,
  getAvatarUsageUser,
  recordMonthlyGeneration,
} from "@/lib/avatarTokens";
import {
  buildAvatarPrompt,
  isSensitiveGenerationError,
  resolveAvatarStyle,
  SENSITIVE_CLIENT_MESSAGE,
} from "@/lib/avatarPrompt";
import { convertImageToPNG, generateWithCreateya, imageUrlToDataUrl } from "@/lib/createya";
import { getAvatarModel, resolveCreateyaAvatarModel } from "@/lib/avatarModels";

export const maxDuration = 120;

type GenerateAvatarBody = {
  name?: unknown;
  appearance?: unknown;
  description?: unknown;
  scenario?: unknown;
  exampleDialogs?: unknown;
  referenceImage?: unknown;
  style?: unknown;
  avatarPrompt?: unknown;
  modelId?: unknown;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    if (!process.env.CREATEYA_API_KEY) {
      return NextResponse.json({ error: "CREATEYA_API_KEY не настроен" }, { status: 500 });
    }

    const body = (await req.json()) as GenerateAvatarBody;
    const name = asText(body.name);
    if (!name) {
      return NextResponse.json({ error: "Укажите имя персонажа" }, { status: 400 });
    }

    // style: 'anime' | 'realistic'; default realistic when missing/invalid
    // avatarPrompt (if set) becomes the main prompt; otherwise name/appearance/description
    const style = resolveAvatarStyle(body.style);
    const prompt = buildAvatarPrompt({
      ...body,
      style,
      customPrompt: asText(body.avatarPrompt) || undefined,
    });
    let referenceImage = asText(body.referenceImage);
    if (referenceImage) {
      referenceImage = await convertImageToPNG(referenceImage);
    }
    const avatarModel = getAvatarModel(body.modelId);
    const apiModel = resolveCreateyaAvatarModel(avatarModel.id, Boolean(referenceImage));
    console.log("[AvatarModel]", {
      modelId: avatarModel.id,
      apiModel,
      hasReference: Boolean(referenceImage),
      costMultiplier: avatarModel.costMultiplier,
    });

    const user = await getAvatarUsageUser(session.user.id);
    const canGenerate = canGenerateThisMonth(user);
    if (!canGenerate.ok) {
      return NextResponse.json(
        { error: canGenerate.reason || "Достигнут месячный лимит бесплатных генераций" },
        { status: 402 }
      );
    }

    const createdUrl = await generateWithCreateya(prompt, referenceImage || undefined, apiModel);
    const imageUrl = await imageUrlToDataUrl(createdUrl);
    await recordMonthlyGeneration(user);

    return NextResponse.json({ imageUrl });
  } catch (error) {
    console.error("Avatar generation error:", error);
    const details = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);

    if (isSensitiveGenerationError(error, details)) {
      return NextResponse.json({ error: SENSITIVE_CLIENT_MESSAGE }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Не удалось сгенерировать аватар";
    const isUserFacing =
      message.includes("кредитов") ||
      message.includes("CREATEYA_API_KEY") ||
      message.includes("время ожидания") ||
      message.includes("референс") ||
      message.includes("запустить генерацию") ||
      message.includes("PNG");

    return NextResponse.json(
      { error: isUserFacing ? message : "Не удалось сгенерировать аватар" },
      { status: 500 }
    );
  }
}
