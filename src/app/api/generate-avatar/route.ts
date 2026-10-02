import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  reserveAvatarGeneration,
  settleAvatarGeneration,
  getAvatarTokenStatus,
} from "@/lib/avatarTokens";
import {
  buildAvatarPrompt,
  isSensitiveGenerationError,
  resolveAvatarStyle,
  SENSITIVE_CLIENT_MESSAGE,
} from "@/lib/avatarPrompt";
import { convertImageToPNG, generateWithCreateya, imageUrlToDataUrl } from "@/lib/createya";
import { getAvatarModel, resolveCreateyaAvatarModel } from "@/lib/avatarModels";
import { AVATAR_BASE_COST_RUB } from "@/lib/avatarEconomy";
import { withAiCostContext, setAiCostActor, withAvatarCost } from "@/lib/aiCostTelemetry";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";

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
  return withAiCostContext(() => generateAvatar(req));
}

async function generateAvatar(req: NextRequest) {
  let reservationId: string | undefined;
  let providerCompleted = false;
  let providerAttempted = false;
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
    const avatarModel = getAvatarModel(body.modelId);
    const apiModel = resolveCreateyaAvatarModel(avatarModel.id, Boolean(referenceImage));
    console.log("[AvatarModel] Selected model:", avatarModel.id);
    console.log("[AvatarModel]", {
      modelId: avatarModel.id,
      apiModel,
      hasReference: Boolean(referenceImage),
      costMultiplier: avatarModel.costMultiplier,
    });

    const reservation = await reserveAvatarGeneration(session.user.id);
    if (!reservation) {
      return NextResponse.json(
        { error: "Достигнут месячный лимит генераций аватара" },
        { status: 402 }
      );
    }

    reservationId = reservation.id;
    setAiCostActor(session.user.id, reservation.user.subscriptionType);
    if (referenceImage) {
      referenceImage = await convertImageToPNG(referenceImage);
    }
    const createdUrl = await withAvatarCost(apiModel, AVATAR_BASE_COST_RUB * avatarModel.costMultiplier,
      onRun => {
        providerAttempted = true;
        return generateWithCreateya(prompt, referenceImage || undefined, apiModel, onRun);
      }, reservation.id);
    providerCompleted = true;
    await settleAvatarGeneration(reservation.id, true);
    const imageUrl = await imageUrlToDataUrl(createdUrl);

    return NextResponse.json({ imageUrl, tokenStatus: getAvatarTokenStatus(reservation.user) });
  } catch (error) {
    if (reservationId && !providerCompleted) {
      const refundable = !providerAttempted || Boolean(error && typeof error === "object" && "avatarQuotaRefundable" in error && error.avatarQuotaRefundable === true);
      // A timeout can hide a completed, billed run. Do not allow retries to bypass the budget.
      await settleAvatarGeneration(reservationId, refundable ? false : "review").catch(err => errorLog("Avatar", "Quota settlement failed", toSafeDiagnostic(err)));
    }
    errorLog("Avatar", "Generation failed", toSafeDiagnostic(error));
    const details = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);

    if (isSensitiveGenerationError(error, details)) {
      return NextResponse.json({ error: SENSITIVE_CLIENT_MESSAGE }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Не удалось сгенерировать аватар";
    const clientError = message.includes("время ожидания")
      ? "Истекло время ожидания. Лимит зарезервирован до проверки результата; обратитесь в поддержку."
      : message.includes("кредитов") || message.includes("CREATEYA_API_KEY")
        ? "Сервис генерации временно недоступен"
        : "Не удалось сгенерировать аватар";

    return NextResponse.json(
      { error: clientError },
      { status: 500 }
    );
  }
}
