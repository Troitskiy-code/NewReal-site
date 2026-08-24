const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const models = [
  { name: "deepseek/deepseek-v4-flash", displayName: "DeepSeek V4 Flash", priceVC: 4, maxContextTokens: 12000, description: "Самая быстрая модель для длинных динамичных переписок." },
  { name: "google/gemma-4-31b-it", displayName: "Gemma 4 31B", priceVC: 4, maxContextTokens: 12000, description: "Лёгкий старт, приятный слог, отличный русский язык." },
  { name: "mistralai/mistral-small-2603", displayName: "Mistral Small 4", priceVC: 5, maxContextTokens: 12000, description: "Хороший баланс цены и качества, живые диалоги." },
  { name: "google/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", priceVC: 12, maxContextTokens: 12000, description: "Креативная, для нестандартных сюжетов и идей." },
  { name: "mistralai/mistral-small-3.1-24b-instruct", displayName: "Mistral Small 3.1 24B", priceVC: 11, maxContextTokens: 12000, description: "Хорошая модель для ролевых игр и сложных персонажей." },
  { name: "anthropic/claude-haiku-4.5", displayName: "Claude Haiku 4.5", priceVC: 34, maxContextTokens: 12000, description: "Надёжный стиль, сильное мышление, без «воды»." },
  { name: "x-ai/grok-4.20", displayName: "Grok 4.20", priceVC: 36, maxContextTokens: 12000, description: "Максимальная реалистичность, минимум галлюцинаций." },
  { name: "google/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", priceVC: 50, maxContextTokens: 12000, description: "Глубокое понимание контекста, построение миров." },
  { name: "mistralai/mistral-large-2407", displayName: "Mistral Large 2", priceVC: 63, maxContextTokens: 12000, description: "Сложные рассуждения, профессиональные сценарии." },
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
