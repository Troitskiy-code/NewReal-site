import ImageTemplate from "@/components/templates/ImageTemplate";
import ChatTemplate from "@/components/templates/ChatTemplate";
import AudioTemplate from "@/components/templates/AudioTemplate";
import VideoTemplate from "@/components/templates/VideoTemplate";

export const templateRegistry = {
  "ai-image": {
    id: "ai-image",
    name: "ИИ-студия изображений",
    description: "Запустите собственную студию ИИ-артов и фото. Идеально для кибerpunk-городов, масляной живописи и сравнений «до/после».",
    component: ImageTemplate,
    modelEndpoint: "predictions", // default MUAPI endpoint
    defaultConfig: {
      systemPrompt: "You are an artistic AI that generates photorealistic image renderings based on text prompts.",
      aspectRatio: "1:1",
      model: "nano-banana-2",
    },
    configFields: [
      { name: "systemPrompt", label: "Базовый контекст запроса", type: "textarea", placeholder: "например: Вы — художник, рисующий маслом на холсте..." },
      { name: "model", label: "Модель изображений", type: "select", options: ["nano-banana-2", "wan2.7", "gpt-image-2"] },
      { name: "aspectRatio", label: "Соотношение сторон по умолчанию", type: "select", options: ["1:1", "16:9", "9:16"] }
    ]
  },
  "ai-video": {
    id: "ai-video",
    name: "ИИ-видеостудия",
    description: "Генерируйте ИИ-видео из текстовых запросов или исходных изображений. Создавайте клипы с движением, анимированные сцены и короткометражки.",
    component: VideoTemplate,
    modelEndpoint: "predictions",
    defaultConfig: {
      systemPrompt: "Generate a smooth, cinematic AI video based on the following description.",
      aspectRatio: "16:9",
      model: "wan2.1",
    },
    configFields: [
      { name: "systemPrompt", label: "Инструкции для генерации видео", type: "textarea", placeholder: "например: Создайте кинематографичный клип в замедленной съёмке с драматическим освещением..." },
      { name: "model", label: "Видеомодель", type: "select", options: ["wan2.1", "nano-banana-2", "wan2.7"] },
      { name: "aspectRatio", label: "Соотношение сторон по умолчанию", type: "select", options: ["16:9", "9:16", "1:1"] }
    ]
  },
  "ai-chat": {
    id: "ai-chat",
    name: "ИИ-чат-компаньон",
    description: "Создавайте персонализированных компаньонов или экспертных ботов поддержки. Подходит для стандартных чатов и плавающих консолей.",
    component: ChatTemplate,
    modelEndpoint: "chat/completions",
    defaultConfig: {
      systemPrompt: "You are an empathetic, highly knowledgeable assistant. Respond details in clear concise markdown format.",
      model: "gpt-4o",
    },
    configFields: [
      { name: "systemPrompt", label: "Инструкции личности бота", type: "textarea", placeholder: "например: Вы — футуристический проводник, говорящий механическими метафорами..." },
      { name: "model", label: "LLM-модель", type: "select", options: ["gpt-4o", "claude-3-5-sonnet", "gemini-1.5-pro"] }
    ]
  },
  "audio-transcribe": {
    id: "audio-transcribe",
    name: "Студия расшифровки аудио",
    description: "Превращайте аудиофайлы, подкасты и записи в точный текст, SRT-субтитры и заметки встреч.",
    component: AudioTemplate,
    modelEndpoint: "predictions", // Whisper predictions
    defaultConfig: {
      systemPrompt: "Transcribe the following audio accurately, retaining all verbal statements.",
      model: "openai-whisper",
    },
    configFields: [
      { name: "systemPrompt", label: "Инструкции для расшифровки", type: "textarea", placeholder: "например: Оформите расшифровку с чёткими абзацами..." },
      { name: "model", label: "Движок распознавания речи", type: "select", options: ["openai-whisper"] }
    ]
  }
};

export const getTemplate = (id) => templateRegistry[id] || null;
export const getAllTemplates = () => Object.values(templateRegistry);
