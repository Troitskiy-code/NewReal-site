import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
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
import { convertImageToPNG, generateWithCreateya, imageUrlToDataUrl } from "@/lib/createya";

export const maxDuration = 90;

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

    const paymentMethod = asText(body.paymentMethod) === "paid" ? "paid" : "free";
    const prompt = buildAvatarPrompt(body);
    let referenceImage = asText(body.referenceImage);
    if (referenceImage) {
      referenceImage = await convertImageToPNG(referenceImage);
    }
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

    const createdUrl = await generateWithCreateya(prompt, referenceImage || undefined, modelType);
    const imageUrl = await imageUrlToDataUrl(createdUrl);

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
