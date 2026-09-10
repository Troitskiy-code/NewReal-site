import { prisma } from "@/lib/prisma";
import { ensureNotificationTable } from "@/lib/ensureNotificationTable";
import { errorLog, infoLog } from "@/lib/logger";

export type NotificationType =
  | "purchase_vc"
  | "purchase_subscription"
  | "daily_bonus"
  | "admin";

export async function createNotification(
  userId: string,
  type: string,
  title: string,
  message: string,
  link?: string | null
) {
  try {
    await ensureNotificationTable();
    const notification = await prisma.notification.create({
      data: {
        userId,
        type,
        title,
        message,
        link: link || null,
      },
    });
    infoLog("Notifications", `Created type=${type} user=${userId} id=${notification.id}`);
    return notification;
  } catch (error) {
    errorLog("Notifications", "Failed to create notification", error);
    return null;
  }
}
