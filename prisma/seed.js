const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const models = [
  { name: "google/gemma-4-31b-it", displayName: "Gemma 4 31B", priceVC: 4, maxContextTokens: 12000, description: "Базовая модель с контекстом 12K. Экономный выбор для простых диалогов." },
  { name: "deepseek/deepseek-v4-flash", displayName: "DeepSeek V4 Flash", priceVC: 8, maxContextTokens: 12000, description: "Быстрая модель для динамичных историй. Контекст 12K." },
  { name: "minimax/minimax-m2.7", displayName: "Minimax M2.7", priceVC: 12, maxContextTokens: 12000, description: "Сбалансированная модель для ролевых игр." },
  { name: "mistralai/mistral-medium-3.1", displayName: "Mistral Medium 3.1", priceVC: 22, maxContextTokens: 12000, description: "Глубокий контекст 12K, хорошее понимание диалогов." },
  { name: "google/gemini-3-flash-preview", displayName: "Gemini 3 Flash", priceVC: 30, maxContextTokens: 12000, description: "Мощная модель с контекстом 12K, отличная для сложных сюжетов." },
  { name: "z-ai/glm-5", displayName: "GLM 5", priceVC: 30, maxContextTokens: 12000, description: "Китайская модель, сильная логика и контекст 12K." },
  { name: "z-ai/glm-5.1", displayName: "GLM 5.1", priceVC: 34, maxContextTokens: 12000, description: "Улучшенная версия GLM, контекст 12K." },
  { name: "x-ai/grok-4.20", displayName: "Grok 4.20", priceVC: 60, maxContextTokens: 12000, description: "12K контекста, мощная модель для экспертных задач." },
  { name: "anthropic/claude-haiku-4.5", displayName: "Claude Haiku 4.5", priceVC: 70, maxContextTokens: 12000, description: "12K контекста, максимальная логика и качество ответов." },
];

async function main() {
  await prisma.user.updateMany({
    data: { selectedModelId: null },
  });

  await prisma.model.deleteMany();

  for (const model of models) {
    await prisma.model.create({
      data: {
        ...model,
        isActive: true,
        isFreeForSubscribers: false,
      },
    });
  }

  console.log("✅ Модели обновлены");
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
