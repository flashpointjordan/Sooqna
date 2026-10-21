import { prisma } from "../src/config/prisma";
import { cleanupNotifications } from "../src/modules/notifications/notifications.cleanup";

void cleanupNotifications({
  findNotificationIds: async (now, take) => (await prisma.notification.findMany({ where: { OR: [{ expiresAt: { lte: now } }, { deletedAt: { not: null } }] }, orderBy: { id: "asc" }, take, select: { id: true } })).map((row) => row.id),
  deleteNotifications: async (ids) => (await prisma.notification.deleteMany({ where: { id: { in: ids } } })).count,
  deleteProcessedOutbox: async (cutoff) => (await prisma.notificationOutbox.deleteMany({ where: { state: "PROCESSED", processedAt: { lt: cutoff } } })).count,
  deleteDeadOutbox: async (cutoff) => (await prisma.notificationOutbox.deleteMany({ where: { state: "DEAD", updatedAt: { lt: cutoff } } })).count,
}).then((result) => { process.stdout.write(`${JSON.stringify(result)}\n`); }).finally(() => prisma.$disconnect());
