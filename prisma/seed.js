const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const models = [
  {
    name: "openai/gpt-4o-mini",
    displayName: "GPT-4o Mini",
    pricePer1MInput: 1.5,
    pricePer1MOutput: 6,
    isFreeForSubscribers: true,
    isActive: true,
  },
  {
    name: "openai/gpt-4o",
    displayName: "GPT-4o",
    pricePer1MInput: 5,
    pricePer1MOutput: 15,
    isFreeForSubscribers: false,
    isActive: true,
  },
  {
    name: "anthropic/claude-sonnet",
    displayName: "Claude Sonnet",
    pricePer1MInput: 3,
    pricePer1MOutput: 15,
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
