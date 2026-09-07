import axios from "axios";
import { memoryToText } from "@/lib/persistentMemory";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const DEFAULT_PROMPT_MODEL = "openai/gpt-4o-mini";

export type CharacterPromptSource = {
  name: string;
  appearance?: string | null;
  description?: string | null;
  scenario?: string | null;
  exampleDialogs?: string | null;
  publicMemory?: unknown;
  privateMemory?: unknown;
};

function memoryOrFallback(value: unknown, emptyLabel: string): string {
  return memoryToText(value).trim() || emptyLabel;
}

function promptModel(): string {
  return process.env.CHARACTER_PROMPT_MODEL?.trim() || DEFAULT_PROMPT_MODEL;
}

export async function generateCharacterPrompt(
  characterData: CharacterPromptSource,
  apiKey: string
): Promise<string> {
  const publicMemory = memoryOrFallback(characterData.publicMemory, "не указана");
  const privateMemory = memoryOrFallback(characterData.privateMemory, "не указана");

  const prompt = `
Ты — мастер создания персонажей для ролевых игр.
На основе следующих данных создай единый, связный промпт для ИИ-персонажа.
Промпт должен быть написан от первого лица (как персонаж) и описывать его характер, внешность, цели, манеру речи и текущую ситуацию.
Используй все предоставленные данные, чтобы сделать промпт живым и детализированным.
Публичную память вплетай как то, что персонаж может рассказывать другим.
Приватную память используй как внутренние мотивы, страхи и скрытые цели: они влияют на поведение, но персонаж не должен раскрывать их сразу и напрямую.

Имя: ${characterData.name}
Внешность: ${characterData.appearance || "не указана"}
Характер и цели: ${characterData.description || "не указан"}
Сценарий: ${characterData.scenario || "не указан"}
Примеры диалогов: ${characterData.exampleDialogs || "не указаны"}
Публичная память (то, что персонаж рассказывает всем): ${publicMemory}
Приватная память (секреты, страхи, привычки): ${privateMemory}

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
      `[CharacterPrompt] Generated length=${prompt.length} name=${characterData.name} hasPublic=${Boolean(memoryToText(characterData.publicMemory).trim())} hasPrivate=${Boolean(memoryToText(characterData.privateMemory).trim())}`
    );
    return prompt;
  } catch (error) {
    console.error("[CharacterPrompt] Generation failed", error);
    return null;
  }
}
