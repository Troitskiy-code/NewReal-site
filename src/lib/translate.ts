const YANDEX_TRANSLATE_URL = "https://translate.api.cloud.yandex.net/translate/v2/translate";

export type TranslateTargetLang = "en" | "ru";

type YandexTranslateResponse = {
  translations?: Array<{
    text?: string;
    detectedLanguageCode?: string;
  }>;
};

export const CHARACTER_EN_FIELDS = [
  "name_en",
  "description_en",
  "appearance_en",
  "greeting_en",
  "scenario_en",
  "exampleDialogs_en",
  "avatarPrompt_en",
] as const;

export type CharacterEnField = (typeof CHARACTER_EN_FIELDS)[number];

export type CharacterSourceField =
  | "name"
  | "description"
  | "appearance"
  | "greeting"
  | "scenario"
  | "exampleDialogs"
  | "avatarPrompt";

const SOURCE_TO_EN_FIELD: Record<CharacterSourceField, CharacterEnField> = {
  name: "name_en",
  description: "description_en",
  appearance: "appearance_en",
  greeting: "greeting_en",
  scenario: "scenario_en",
  exampleDialogs: "exampleDialogs_en",
  avatarPrompt: "avatarPrompt_en",
};

export type CharacterEnTranslations = Partial<Record<CharacterEnField, string | null>>;

function getTranslateConfig() {
  const apiKey = process.env.YANDEX_API_KEY?.trim() ?? "";
  const folderId = process.env.YANDEX_FOLDER_ID?.trim() ?? "";
  return { apiKey, folderId };
}

export async function translateText(text: string, targetLang: TranslateTargetLang): Promise<string> {
  if (!text.trim()) {
    console.log("[Translate] Empty text, skipping request", { targetLang, textLength: 0 });
    return text;
  }

  const { apiKey, folderId } = getTranslateConfig();
  if (!apiKey || !folderId) {
    console.error("[Translate] Missing YANDEX_API_KEY or YANDEX_FOLDER_ID", {
      hasApiKey: Boolean(apiKey),
      hasFolderId: Boolean(folderId),
    });
    throw new Error("Missing YANDEX_API_KEY or YANDEX_FOLDER_ID");
  }

  const requestBody = {
    targetLanguageCode: targetLang,
    texts: [text],
    folderId,
  };

  console.log("[Translate] Request:", {
    textLength: text.length,
    targetLang,
    textPreview: text.slice(0, 80),
    url: YANDEX_TRANSLATE_URL,
    body: {
      targetLanguageCode: requestBody.targetLanguageCode,
      textsCount: requestBody.texts.length,
      textsItemLengths: requestBody.texts.map((t) => t.length),
      folderIdPresent: Boolean(folderId),
    },
    headers: {
      Authorization: "Api-Key ***",
      "Content-Type": "application/json",
    },
  });

  try {
    const response = await fetch(YANDEX_TRANSLATE_URL, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const rawBody = await response.text().catch(() => "");
    console.log("[Translate] Response status:", response.status);

    let data: YandexTranslateResponse | null = null;
    if (rawBody) {
      try {
        data = JSON.parse(rawBody) as YandexTranslateResponse;
        console.log("[Translate] Response data:", data);
      } catch {
        console.log("[Translate] Response body (non-JSON):", rawBody.slice(0, 500));
      }
    }

    if (!response.ok) {
      console.error("[Translate] API error:", response.status, data ?? rawBody.slice(0, 500));
      throw new Error(
        `Yandex Translate API error ${response.status}${rawBody ? `: ${rawBody.slice(0, 300)}` : ""}`
      );
    }

    const translated = data?.translations?.[0]?.text;
    if (typeof translated !== "string" || !translated) {
      console.error("[Translate] Unexpected response shape", data ?? rawBody.slice(0, 500));
      throw new Error("Yandex Translate returned unexpected response shape");
    }

    console.log("[Translate] Success:", {
      targetLang,
      originalLength: text.length,
      translatedLength: translated.length,
      translatedPreview: translated.slice(0, 80),
    });

    return translated;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Yandex Translate")) {
      throw error;
    }
    if (error instanceof Error && error.message === "Missing YANDEX_API_KEY or YANDEX_FOLDER_ID") {
      throw error;
    }
    console.error("[Translate] Request failed", error);
    throw error instanceof Error ? error : new Error("Yandex Translate request failed");
  }
}

export async function translateCharacterFieldsToEn(
  fields: Partial<Record<CharacterSourceField, string | null | undefined>>
): Promise<CharacterEnTranslations> {
  const entries = (Object.keys(SOURCE_TO_EN_FIELD) as CharacterSourceField[]).filter(
    (source) => fields[source] !== undefined
  );

  if (entries.length === 0) {
    return {};
  }

  console.log(`[Translate] Translating ${entries.length} character field(s) to en`);

  const results = await Promise.all(
    entries.map(async (source) => {
      const enField = SOURCE_TO_EN_FIELD[source];
      const value = fields[source];
      if (value == null || !value.trim()) {
        return [enField, null] as const;
      }

      try {
        const translated = await translateText(value, "en");
        return [enField, translated] as const;
      } catch (error) {
        console.error(`[Translate] Field "${source}" failed, keeping original`, error);
        return [enField, value] as const;
      }
    })
  );

  return Object.fromEntries(results);
}
