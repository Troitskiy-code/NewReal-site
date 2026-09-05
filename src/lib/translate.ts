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
    return text;
  }

  const { apiKey, folderId } = getTranslateConfig();
  if (!apiKey || !folderId) {
    console.error("[Translate] Missing YANDEX_API_KEY or YANDEX_FOLDER_ID");
    return text;
  }

  try {
    const response = await fetch(YANDEX_TRANSLATE_URL, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetLanguageCode: targetLang,
        texts: [text],
        folderId,
      }),
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      console.error(
        `[Translate] API error ${response.status}${details ? `: ${details.slice(0, 300)}` : ""}`
      );
      return text;
    }

    const data = (await response.json()) as YandexTranslateResponse;
    const translated = data.translations?.[0]?.text;
    if (typeof translated !== "string" || !translated) {
      console.error("[Translate] Unexpected response shape", data);
      return text;
    }

    return translated;
  } catch (error) {
    console.error("[Translate] Request failed", error);
    return text;
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

      const translated = await translateText(value, "en");
      return [enField, translated] as const;
    })
  );

  return Object.fromEntries(results);
}
