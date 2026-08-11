const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const models = [
  {
    name: "openai/gpt-4o-mini",
    displayName: "Базовая",
    pricePer1MInput: 1.5,
    pricePer1MOutput: 6,
    priceVC: 0,
    description:
      "Быстрая и лёгкая модель для повседневного общения. Подходит для коротких и динамичных историй.",
    isFreeForSubscribers: true,
    isActive: true,
  },
  {
    name: "openai/gpt-4o",
    displayName: "Стандартная",
    pricePer1MInput: 5,
    pricePer1MOutput: 15,
    priceVC: 8,
    description:
      "Сбалансированная модель для ролевых игр и диалогов. Хороша для глубоких сюжетов.",
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "anthropic/claude-3.5-sonnet",
    displayName: "Продвинутая",
    pricePer1MInput: 3,
    pricePer1MOutput: 15,
    priceVC: 19,
    description:
      "Мощная модель с высоким качеством ответов. Идеальна для сложных персонажей и захватывающих историй.",
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "openai/o1",
    displayName: "Экспертная",
    pricePer1MInput: 15,
    pricePer1MOutput: 60,
    priceVC: 47,
    description:
      "Модель для экспертных задач и интеллектуальных диалогов. Требует вдумчивого подхода.",
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "openai/gpt-5",
    displayName: "Флагманская",
    pricePer1MInput: 25,
    pricePer1MOutput: 100,
    priceVC: 93,
    description:
      "Флагманская модель с неограниченными возможностями. Для самых требовательных игроков.",
    isFreeForSubscribers: false,
    isActive: true,
  },
];

async function main() {
  for (const model of models) {
    await prisma.model.upsert({
      where: { name: model.name },
      update: model,
      create: model,
    });
  }
  console.log("Модели успешно добавлены:", models.length);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
