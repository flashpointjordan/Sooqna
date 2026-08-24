import { NotificationCategory, type NotificationType } from "@prisma/client";
import { AppError } from "../../shared/errors/appError";
import { renderNotification } from "./notifications.templates";
import type { NotificationDto, NotificationEventPayload, NotificationListQuery, NotificationMetadata } from "./notifications.types";

export type StoredNotification = {
  id: string; userId: string; type: NotificationType; category: NotificationCategory; title: string; body: string; actionUrl: string | null; entityType: string | null; entityId: string | null; metadata: NotificationMetadata; dedupeKey: string | null; aggregationKey: string | null; readAt: Date | null; deletedAt: Date | null; expiresAt: Date; createdAt: Date; updatedAt: Date;
};
export type OwnedNotificationMutation = { row: StoredNotification; changed: boolean };
export type NotificationsRepository = {
  listActive(userId: string, query: NotificationListQuery, now: Date): Promise<{ items: StoredNotification[]; hasMore: boolean; nextCursor: string | null }>;
  countUnread(userId: string, now: Date): Promise<number>;
  findActiveOwned(userId: string, id: string, now: Date): Promise<StoredNotification | null>;
  markReadOwned(userId: string, id: string, now: Date): Promise<OwnedNotificationMutation | null>;
  markAllRead(userId: string, now: Date): Promise<number>;
  softDeleteOwned(userId: string, id: string, now: Date): Promise<OwnedNotificationMutation | null>;
  getPreferences(userId: string): Promise<Array<{ category: NotificationCategory; enabled: boolean }>>;
  upsertPreferences(userId: string, values: Partial<Record<NotificationCategory, boolean>>): Promise<Array<{ category: NotificationCategory; enabled: boolean }>>;
  findByDedupeKey(dedupeKey: string): Promise<StoredNotification | null>;
  findCurrentAggregate(aggregationKey: string): Promise<StoredNotification | null>;
  create(input: Omit<StoredNotification, "id" | "updatedAt">): Promise<StoredNotification>;
  updateAggregate(id: string, input: Partial<Pick<StoredNotification, "title" | "body" | "actionUrl" | "metadata" | "expiresAt" | "updatedAt">>): Promise<StoredNotification>;
};
type Options = { now?: () => Date; publishSignal?: (userId: string, notificationId: string, unreadCount: number) => Promise<void> | void };
const optional = [NotificationCategory.MESSAGES, NotificationCategory.LISTINGS, NotificationCategory.ENGAGEMENT, NotificationCategory.SAVED_SEARCHES] as const;
const locked = [NotificationCategory.SYSTEM, NotificationCategory.SECURITY] as const;

export class NotificationsService {
  private readonly now: () => Date;
  private readonly publishSignal: NonNullable<Options["publishSignal"]>;
  constructor(private readonly repo: NotificationsRepository, options: Options = {}) { this.now = options.now ?? (() => new Date()); this.publishSignal = options.publishSignal ?? (() => undefined); }
  async list(userId: string, query: NotificationListQuery): Promise<{ items: NotificationDto[]; hasMore: boolean; nextCursor: string | null }> { const result = await this.repo.listActive(userId, { ...query, limit: Math.min(query.limit, 50) }, this.now()); return { ...result, items: result.items.map(toDto) }; }
  async unreadCount(userId: string): Promise<number> { return this.repo.countUnread(userId, this.now()); }
  async markRead(userId: string, id: string): Promise<NotificationDto> { const result = await this.repo.markReadOwned(userId, id, this.now()); if (!result) throw notFound(); if (result.changed) await this.signal(userId, result.row.id); return toDto(result.row); }
  async markAllRead(userId: string): Promise<{ updatedCount: number; unreadCount: number }> { const updatedCount = await this.repo.markAllRead(userId, this.now()); const unreadCount = await this.unreadCount(userId); if (updatedCount > 0) await this.publishSignal(userId, "", unreadCount); return { updatedCount, unreadCount }; }
  async delete(userId: string, id: string): Promise<NotificationDto> { const result = await this.repo.softDeleteOwned(userId, id, this.now()); if (!result) throw notFound(); if (result.changed) await this.signal(userId, result.row.id); return toDto(result.row); }
  async getPreferences(userId: string): Promise<Record<NotificationCategory, boolean>> { const stored = new Map((await this.repo.getPreferences(userId)).map((item) => [item.category, item.enabled])); return Object.fromEntries([...optional.map((category) => [category, stored.get(category) ?? true]), ...locked.map((category) => [category, true])]) as Record<NotificationCategory, boolean>; }
  async updatePreferences(userId: string, values: Partial<Record<NotificationCategory, boolean>>) { const permissible = Object.fromEntries(optional.filter((category) => values[category] !== undefined).map((category) => [category, values[category]!])) as Partial<Record<NotificationCategory, boolean>>; await this.repo.upsertPreferences(userId, permissible); return this.getPreferences(userId); }
  async createFromEvent(type: NotificationType, payload: NotificationEventPayload, options: { dedupeKey?: string; aggregationKey?: string } = {}): Promise<NotificationDto | null> {
    if (options.dedupeKey) { const existing = await this.repo.findByDedupeKey(options.dedupeKey); if (existing) return toDto(existing); }
    const rendered = renderNotification(type, payload); const preferences = await this.getPreferences(payload.recipientId);
    if (!preferences[rendered.category]) return null;
    const createdAt = this.now(); const expiresAt = new Date(createdAt.getTime() + 90 * 24 * 60 * 60 * 1000);
    if (options.aggregationKey) {
      const existing = await this.repo.findCurrentAggregate(options.aggregationKey);
      if (existing) {
        const updated = await this.repo.updateAggregate(existing.id, { title: rendered.title, body: rendered.body, actionUrl: rendered.actionUrl, metadata: rendered.metadata, expiresAt, updatedAt: createdAt });
        await this.signal(updated.userId, updated.id); return toDto(updated);
      }
    }
    const row = await this.repo.create({ userId: payload.recipientId, type, ...rendered, dedupeKey: options.dedupeKey ?? null, aggregationKey: options.aggregationKey ?? null, readAt: null, deletedAt: null, expiresAt, createdAt });
    await this.signal(row.userId, row.id); return toDto(row);
  }
  private async signal(userId: string, notificationId: string): Promise<void> { await this.publishSignal(userId, notificationId, await this.unreadCount(userId)); }
}
function toDto(row: StoredNotification): NotificationDto { return { id: row.id, type: row.type, category: row.category, title: row.title, body: row.body, actionUrl: row.actionUrl, entityType: row.entityType, entityId: row.entityId, metadata: row.metadata, readAt: row.readAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() }; }
function notFound(): AppError { return new AppError(404, "Notification not found.", "NOT_FOUND"); }
