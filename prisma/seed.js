const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const models = [
  {
    name: "openai/gpt-4o-mini",
    displayName: "GPT-4o-mini",
    priceVC: 4,
    description: "Быстрая и надёжная. Идеальна для повседневных диалогов.",
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "deepseek/deepseek-v3.2",
    displayName: "DeepSeek V3.2",
    priceVC: 4,
    description: "Отличный русский язык и низкая цена.",
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "deepseek/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    priceVC: 8,
    description: "Живой диалог, глубокое понимание контекста.",
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "deepseek/deepseek-v4-flash",
    displayName: "DeepSeek V4-Flash",
    priceVC: 12,
    description: "Молниеносная скорость, идеальна для длинных переписок.",
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "google/gemini-2.0-flash",
    displayName: "Gemini 2.0 Flash",
    priceVC: 16,
    description: "Быстрая, креативная, для генерации идей.",
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "anthropic/claude-3.5-sonnet",
    displayName: "Claude 3.5 Sonnet",
    priceVC: 30,
    description: "Высокий эмоциональный интеллект, реалистичные диалоги.",
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "openai/gpt-4o",
    displayName: "GPT-4o",
    priceVC: 35,
    description: "Универсальный лидер, баланс качества и цены.",
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "google/gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    priceVC: 35,
    description: "Глубокое понимание, идеален для миров и длинных нарративов.",
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "anthropic/claude-opus-4",
    displayName: "Claude Opus 4",
    priceVC: 60,
    description: "Максимальное качество, профессиональные сценарии.",
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "openai/gpt-5.2",
    displayName: "GPT-5.2",
    priceVC: 60,
    description: "Флагманская модель, интеллект эксперта.",
    isFreeForSubscribers: false,
    isActive: true,
  },
];

async function main() {
  await prisma.user.updateMany({
    data: { selectedModelId: null },
  });

  const deleted = await prisma.model.deleteMany();
  console.log(`Удалено моделей: ${deleted.count}`);

  for (const model of models) {
    await prisma.model.create({ data: model });
  }

  console.log(`Добавлено моделей: ${models.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
