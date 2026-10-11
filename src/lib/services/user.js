import { prisma } from "../prisma";

export const UserService = {
  async getCredits(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { credits: true },
    });
    return user ? user.credits : 0;
  },

  async addCredits(userId, amount) {
    if (amount <= 0) return;
    return await prisma.user.update({
      where: { id: userId },
      data: {
        credits: {
          increment: amount,
        },
      },
    });
  },

  async deductCredits(userId, amount) {
    if (amount <= 0) return;

    // Check and decrement in one statement so parallel requests cannot overdraw.
    const result = await prisma.user.updateMany({
      where: { id: userId, credits: { gte: amount } },
      data: {
        credits: {
          decrement: amount,
        },
      },
    });
    if (result.count === 0) {
      throw new Error("Insufficient credits available");
    }
    return result;
  },
};
