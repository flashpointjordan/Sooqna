import { NotificationOutboxState, Prisma, type NotificationCategory } from "@prisma/client";
import { AppError } from "../../shared/errors/appError";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { decodeNotificationCursor, encodeNotificationCursor, type NotificationListQuery } from "./notifications.types";
import type { AggregatePersistence, NewNotification, NotificationsRepository, OwnedNotificationMutation, StoredNotification } from "./notifications.service";
import type { NotificationOutboxRecord, NotificationOutboxRepository } from "./notifications.worker";
import { JsonNotificationsRepository } from "./notifications.json.repository";
import { isStaleAggregate, mergeSavedSearchAggregate } from "./notifications.aggregate";
export { JsonNotificationsRepository, type JsonNotificationsStore } from "./notifications.json.repository";

export function createNotificationsRepository(): NotificationsRepository & NotificationOutboxRepository {
  return env.enableCategoriesJsonFallback && !env.databaseUrl
    ? new JsonNotificationsRepository()
    : new PrismaNotificationsRepository();
}

function cursorWhere(cursor: string | undefined): Prisma.NotificationWhereInput | undefined {
  if (!cursor) return undefined;
  const value = decodeNotificationCursor(cursor);
  const createdAt = new Date(value.createdAt);
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: value.id } }] };
}

export class PrismaNotificationsRepository implements NotificationsRepository, NotificationOutboxRepository {
  async recoverStaleProcessing(now: Date, staleBefore: Date): Promise<{ recovered: number; dead: Array<{ id: string; attempts: number }> }> {
    const dead = await prisma.$queryRaw<Array<{ id: string; attempts: number }>>(Prisma.sql`
      UPDATE "NotificationOutbox"
      SET "state" = 'DEAD'::"NotificationOutboxState", "updatedAt" = ${now}
      WHERE "state" = 'PROCESSING'::"NotificationOutboxState"
        AND "attempts" >= 8
        AND "updatedAt" < ${staleBefore}
      RETURNING "id", "attempts"
    `);
    const result = await prisma.notificationOutbox.updateMany({
      where: { state: NotificationOutboxState.PROCESSING, attempts: { lt: 8 }, updatedAt: { lt: staleBefore } },
      data: { state: NotificationOutboxState.FAILED, availableAt: now },
    });
    return { recovered: dead.length + result.count, dead };
  }
  async claimReady(limit: number, now: Date): Promise<NotificationOutboxRecord[]> {
    const bounded = Math.max(1, Math.min(limit, 200));
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: string; eventType: NotificationOutboxRecord["eventType"]; aggregateType: string; aggregateId: string; recipientId: string | null; payload: unknown; dedupeKey: string; state: NotificationOutboxState; attempts: number; availableAt: Date; processedAt: Date | null; lastError: string | null; createdAt: Date; updatedAt: Date;
      }>>(Prisma.sql`
        SELECT "id", "eventType", "aggregateType", "aggregateId", "recipientId", "payload", "dedupeKey", "state", "attempts", "availableAt", "processedAt", "lastError", "createdAt", "updatedAt"
        FROM "NotificationOutbox"
        WHERE "state" IN ('PENDING'::"NotificationOutboxState", 'FAILED'::"NotificationOutboxState")
          AND "availableAt" <= ${now}
          AND "attempts" < 8
        ORDER BY "availableAt" ASC, "createdAt" ASC, "id" ASC
        LIMIT ${bounded}
        FOR UPDATE SKIP LOCKED
      `);
      if (rows.length === 0) return [];
      await tx.notificationOutbox.updateMany({ where: { id: { in: rows.map((row) => row.id) }, state: { in: [NotificationOutboxState.PENDING, NotificationOutboxState.FAILED] }, attempts: { lt: 8 } }, data: { state: NotificationOutboxState.PROCESSING, attempts: { increment: 1 } } });
      return rows.map((row) => ({ ...row, state: NotificationOutboxState.PROCESSING, attempts: row.attempts + 1, claimAttempt: row.attempts + 1 }));
    });
  }
  async markProcessed(id: string, claimAttempt: number, now: Date): Promise<boolean> {
    const result = await prisma.notificationOutbox.updateMany({ where: { id, attempts: claimAttempt, state: NotificationOutboxState.PROCESSING }, data: { state: NotificationOutboxState.PROCESSED, processedAt: now, lastError: null } });
    return result.count > 0;
  }
  async markFailure(id: string, claimAttempt: number, error: string, availableAt: Date, _now: Date): Promise<NotificationOutboxState> {
    if (claimAttempt >= 8) {
      const dead = await prisma.notificationOutbox.updateMany({ where: { id, attempts: claimAttempt, state: NotificationOutboxState.PROCESSING }, data: { state: NotificationOutboxState.DEAD, lastError: error.slice(0, 500), availableAt, processedAt: null } });
      if (dead.count > 0) return NotificationOutboxState.DEAD;
    }
    const failed = await prisma.notificationOutbox.updateMany({ where: { id, attempts: claimAttempt, state: NotificationOutboxState.PROCESSING }, data: { state: NotificationOutboxState.FAILED, lastError: error.slice(0, 500), availableAt, processedAt: null } });
    return failed.count > 0 ? NotificationOutboxState.FAILED : NotificationOutboxState.PROCESSING;
  }
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
  async markReadOwned(userId: string, id: string, now: Date): Promise<OwnedNotificationMutation | null> {
    const changed = await prisma.notification.updateMany({ where: { id, userId, deletedAt: null, expiresAt: { gt: now }, readAt: null }, data: { readAt: now } });
    const row = await this.findActiveOwned(userId, id, now);
    return row ? { row, changed: changed.count > 0 } : null;
  }
  async markAllRead(userId: string, now: Date): Promise<number> { const result = await prisma.notification.updateMany({ where: { userId, readAt: null, deletedAt: null, expiresAt: { gt: now } }, data: { readAt: now } }); return result.count; }
  async softDeleteOwned(userId: string, id: string, now: Date): Promise<OwnedNotificationMutation | null> {
    const changed = await prisma.notification.updateMany({ where: { id, userId, deletedAt: null, expiresAt: { gt: now } }, data: { deletedAt: now } });
    const row = await prisma.notification.findFirst({ where: { id, userId, expiresAt: { gt: now } } });
    return row ? { row: toStored(row), changed: changed.count > 0 } : null;
  }
  async getPreferences(userId: string) { return prisma.notificationPreference.findMany({ where: { userId }, select: { category: true, enabled: true } }); }
  async upsertPreferences(userId: string, values: Partial<Record<NotificationCategory, boolean>>) {
    await prisma.$transaction(async (tx) => {
      for (const [category, enabled] of Object.entries(values)) {
        await tx.notificationPreference.upsert({ where: { userId_category: { userId, category: category as NotificationCategory } }, create: { userId, category: category as NotificationCategory, enabled: Boolean(enabled) }, update: { enabled: Boolean(enabled) } });
      }
    });
    return this.getPreferences(userId);
  }
  async findByDedupeKey(dedupeKey: string): Promise<StoredNotification | null> { const row = await prisma.notification.findUnique({ where: { dedupeKey } }); return row && toStored(row); }
  async findCurrentAggregate(aggregationKey: string): Promise<StoredNotification | null> { const row = await prisma.notification.findFirst({ where: { aggregationKey, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }); return row && toStored(row); }
  async create(input: NewNotification): Promise<StoredNotification> { return toStored(await prisma.notification.create({ data: { ...input, metadata: input.metadata as Prisma.InputJsonValue } })); }
  async persistAggregate(input: NewNotification & { aggregationKey: string }): Promise<AggregatePersistence | null> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.aggregationKey}, 0))`);
      const existing = await tx.notification.findFirst({ where: { userId: input.userId, aggregationKey: input.aggregationKey, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      if (input.dedupeKey) {
        const ledger = await tx.notificationOutbox.findUnique({ where: { dedupeKey: input.dedupeKey } });
        if (!ledger) throw new AppError(400, "Notification outbox event was not found.", "NOTIFICATION_EVENT_NOT_FOUND");
        if (ledger.state === NotificationOutboxState.PROCESSED) return existing ? { row: toStored(existing), changed: false } : null;
        if (ledger.state !== NotificationOutboxState.PENDING && ledger.state !== NotificationOutboxState.PROCESSING) return null;
      }
      if (existing && isStaleAggregate(input.type, toStored(existing).metadata, input.metadata)) return { row: toStored(existing), changed: false };
      const aggregateInput = existing && input.type === "SAVED_SEARCH_MATCHES"
        ? withSavedSearchAggregate(input, toStored(existing).metadata)
        : input;
      const result = existing
        ? toStored(await tx.notification.update({ where: { id: existing.id }, data: { title: aggregateInput.title, body: aggregateInput.body, actionUrl: aggregateInput.actionUrl, metadata: aggregateInput.metadata as Prisma.InputJsonValue, expiresAt: aggregateInput.expiresAt, readAt: null } }))
        : toStored(await tx.notification.create({ data: { ...input, metadata: input.metadata as Prisma.InputJsonValue } }));
      return { row: result, changed: true };
    });
  }
  async updateAggregate(id: string, input: Partial<Pick<StoredNotification, "title" | "body" | "actionUrl" | "metadata" | "expiresAt" | "updatedAt">>): Promise<StoredNotification> { return toStored(await prisma.notification.update({ where: { id }, data: { ...input, ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}), readAt: null } })); }
}

function withSavedSearchAggregate(input: NewNotification, current: Record<string, string | number | string[]>): NewNotification {
  const metadata = mergeSavedSearchAggregate(current, input.metadata);
  const total = typeof metadata.totalCount === "number" ? metadata.totalCount : 0;
  const name = typeof metadata.savedSearchName === "string" ? metadata.savedSearchName : "";
  return { ...input, metadata, body: `وجدنا ${total} نتيجة جديدة لبحث «${name}».` };
}


function toStored(row: Awaited<ReturnType<typeof prisma.notification.findFirst>> & object): StoredNotification {
  const metadata: Record<string, string | number | string[]> = {};
  if (row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)) {
    for (const [key, value] of Object.entries(row.metadata)) if (typeof value === "string" || typeof value === "number" || (Array.isArray(value) && value.every((item) => typeof item === "string"))) metadata[key] = value as string | number | string[];
  }
  return { ...row, metadata };
}
