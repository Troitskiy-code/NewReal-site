import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";
import { isTestingChatModel } from "@/lib/testingChatModels";
import { chatModelNameFilter, getChatProvider } from "@/lib/aiProviders";
import { DEEPINFRA_BASE_MODEL } from "@/lib/deepinfraModels";
import { isFreeDailyQuotaEnabled } from "@/lib/freeDailyQuotaServer";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    const models = await prisma.model.findMany({
      where: { isActive: true, name: chatModelNameFilter() },
      orderBy: [{ priceVC: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        displayName: true,
        pricePer1MInput: true,
        pricePer1MOutput: true,
        priceVC: true,
        maxContextTokens: true,
        description: true,
        isFreeForSubscribers: true,
        isActive: true,
      },
    });

    const baseModel = getChatProvider() === "deepinfra" ? models.find((model) => model.name === DEEPINFRA_BASE_MODEL) ?? null
      : models.find((model) => !isTestingChatModel(model.name)) ?? null;

    let selectedModelId: string | null = null;
    let subscriptionActive = false;

    if (session?.user?.id) {
      const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: {
          selectedModelId: true,
          subscriptionType: true,
          subscriptionEnd: true,
        },
      });
      selectedModelId = models.some((model) => model.id === user?.selectedModelId)
        ? user?.selectedModelId ?? null : null;
      subscriptionActive = user ? isSubscriptionActive(user) : false;
    }

    return NextResponse.json({
      models: models.map((model) => ({ ...model, isTesting: isTestingChatModel(model.name) })),
      selectedModelId,
      subscriptionActive,
      baseModelId: baseModel?.id ?? null,
      // Lets public plan cards mention the free daily replies only while the quota is switched on.
      freeQuota: isFreeDailyQuotaEnabled() && baseModel ? { modelName: baseModel.displayName } : null,
    });
  } catch (error) {
    errorLog("Server", "Models fetch error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
