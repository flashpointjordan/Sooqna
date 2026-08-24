import { Prisma, type NotificationCategory } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { decodeNotificationCursor, encodeNotificationCursor, type NotificationListQuery } from "./notifications.types";
import type { NotificationsRepository, StoredNotification } from "./notifications.service";

function cursorWhere(cursor: string | undefined): Prisma.NotificationWhereInput | undefined {
  if (!cursor) return undefined;
  const value = decodeNotificationCursor(cursor);
  const createdAt = new Date(value.createdAt);
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: value.id } }] };
}

export class PrismaNotificationsRepository implements NotificationsRepository {
  async listActive(userId: string, query: NotificationListQuery, now: Date) {
    const where: Prisma.NotificationWhereInput = {
      userId, deletedAt: null, expiresAt: { gt: now }, ...cursorWhere(query.cursor),
      ...(query.category ? { category: query.category } : {}),
      ...(query.unread === undefined ? {} : { readAt: query.unread ? null : { not: null } }),
    };
    const rows = await prisma.notification.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: Math.min(query.limit, 50) + 1 });
    const hasMore = rows.length > Math.min(query.limit, 50);
    const items = hasMore ? rows.slice(0, -1) : rows;
    const last = items.at(-1);
    return { items: items.map(toStored), hasMore, nextCursor: hasMore && last ? encodeNotificationCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null };
  }

  async countUnread(userId: string, now: Date): Promise<number> { return prisma.notification.count({ where: { userId, readAt: null, deletedAt: null, expiresAt: { gt: now } } }); }
  async findActiveOwned(userId: string, id: string, now: Date): Promise<StoredNotification | null> { const row = await prisma.notification.findFirst({ where: { id, userId, deletedAt: null, expiresAt: { gt: now } } }); return row && toStored(row); }
  async markReadOwned(userId: string, id: string, now: Date): Promise<StoredNotification | null> {
    const existing = await this.findActiveOwned(userId, id, now);
    if (!existing || existing.readAt) return existing;
    return toStored(await prisma.notification.update({ where: { id }, data: { readAt: now } }));
  }
  async markAllRead(userId: string, now: Date): Promise<number> { const result = await prisma.notification.updateMany({ where: { userId, readAt: null, deletedAt: null, expiresAt: { gt: now } }, data: { readAt: now } }); return result.count; }
  async softDeleteOwned(userId: string, id: string, now: Date): Promise<StoredNotification | null> {
    const existing = await prisma.notification.findFirst({ where: { id, userId, expiresAt: { gt: now } } });
    if (!existing || existing.deletedAt) return existing && toStored(existing);
    return toStored(await prisma.notification.update({ where: { id }, data: { deletedAt: now } }));
  }
  async getPreferences(userId: string) { return prisma.notificationPreference.findMany({ where: { userId }, select: { category: true, enabled: true } }); }
  async upsertPreferences(userId: string, values: Partial<Record<NotificationCategory, boolean>>) {
    await Promise.all(Object.entries(values).map(([category, enabled]) => prisma.notificationPreference.upsert({ where: { userId_category: { userId, category: category as NotificationCategory } }, create: { userId, category: category as NotificationCategory, enabled: Boolean(enabled) }, update: { enabled: Boolean(enabled) } })));
    return this.getPreferences(userId);
  }
  async findByDedupeKey(dedupeKey: string): Promise<StoredNotification | null> { const row = await prisma.notification.findUnique({ where: { dedupeKey } }); return row && toStored(row); }
  async findCurrentAggregate(aggregationKey: string): Promise<StoredNotification | null> { const row = await prisma.notification.findFirst({ where: { aggregationKey, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }); return row && toStored(row); }
  async create(input: Omit<StoredNotification, "id" | "updatedAt">): Promise<StoredNotification> { return toStored(await prisma.notification.create({ data: { ...input, metadata: input.metadata as Prisma.InputJsonValue } })); }
  async updateAggregate(id: string, input: Partial<Pick<StoredNotification, "title" | "body" | "actionUrl" | "metadata" | "expiresAt" | "updatedAt">>): Promise<StoredNotification> { return toStored(await prisma.notification.update({ where: { id }, data: { ...input, ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}) } })); }
}

function toStored(row: Awaited<ReturnType<typeof prisma.notification.findFirst>> & object): StoredNotification {
  const metadata: Record<string, string | number | string[]> = {};
  if (row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)) {
    for (const [key, value] of Object.entries(row.metadata)) if (typeof value === "string" || typeof value === "number" || (Array.isArray(value) && value.every((item) => typeof item === "string"))) metadata[key] = value as string | number | string[];
  }
  return { ...row, metadata };
}
