import axios from "axios";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const DEFAULT_PROMPT_MODEL = "openai/gpt-4o-mini";

export type CharacterPromptSource = {
  name: string;
  appearance?: string | null;
  description?: string | null;
  scenario?: string | null;
  exampleDialogs?: string | null;
};

function promptModel(): string {
  return process.env.CHARACTER_PROMPT_MODEL?.trim() || DEFAULT_PROMPT_MODEL;
}

export async function generateCharacterPrompt(
  characterData: CharacterPromptSource,
  apiKey: string
): Promise<string> {
  const prompt = `
Ты — мастер создания персонажей для ролевых игр.
На основе следующих данных создай единый, связный промпт для ИИ-персонажа.
Промпт должен быть написан от первого лица (как персонаж) и описывать его характер, внешность, цели, манеру речи и текущую ситуацию.
Используй все предоставленные данные, чтобы сделать промпт живым и детализированным.

Имя: ${characterData.name}
Внешность: ${characterData.appearance || "не указана"}
Характер и цели: ${characterData.description || "не указан"}
Сценарий: ${characterData.scenario || "не указан"}
Примеры диалогов: ${characterData.exampleDialogs || "не указаны"}

Создай промпт (не более 500 слов), который можно использовать как системный промпт для чата.
`.trim();

  const response = await axios.post(
    `${KODIKROUTER_URL}/chat/completions`,
    {
      model: promptModel(),
      messages: [
        { role: "system", content: "Ты — ассистент для создания персонажей." },
        { role: "user", content: prompt },
      ],
      max_tokens: 1000,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const content = response.data?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

export async function tryGenerateCharacterPrompt(
  characterData: CharacterPromptSource
): Promise<string | null> {
  const apiKey = process.env.KODIKROUTER_API_KEY?.trim() ?? "";
  if (!apiKey) {
    console.error("[CharacterPrompt] KODIKROUTER_API_KEY is not set");
    return null;
  }

  try {
    const prompt = await generateCharacterPrompt(characterData, apiKey);
    if (!prompt) {
      console.error("[CharacterPrompt] Empty model response");
      return null;
    }
    console.log(
      `[CharacterPrompt] Generated length=${prompt.length} name=${characterData.name}`
    );
    return prompt;
  } catch (error) {
    console.error("[CharacterPrompt] Generation failed", error);
    return null;
  }
}
