const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const models = [
  {
    name: "openai/gpt-4o-mini",
    displayName: "Базовая",
    pricePer1MInput: 1.5,
    pricePer1MOutput: 6,
    priceVC: 0,
    isFreeForSubscribers: true,
    isActive: true,
  },
  {
    name: "openai/gpt-4o",
    displayName: "Стандартная",
    pricePer1MInput: 5,
    pricePer1MOutput: 15,
    priceVC: 8,
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "anthropic/claude-3.5-sonnet",
    displayName: "Продвинутая",
    pricePer1MInput: 3,
    pricePer1MOutput: 15,
    priceVC: 19,
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "openai/o1",
    displayName: "Экспертная",
    pricePer1MInput: 15,
    pricePer1MOutput: 60,
    priceVC: 47,
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "openai/gpt-5",
    displayName: "Флагманская",
    pricePer1MInput: 25,
    pricePer1MOutput: 100,
    priceVC: 93,
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
