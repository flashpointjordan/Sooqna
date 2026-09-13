import { NotificationCategory, NotificationType } from "@prisma/client";
import { AppError } from "../../shared/errors/appError";
import { renderNotification } from "./notifications.templates";
import type { NotificationDto, NotificationEventPayload, NotificationListQuery, NotificationMetadata } from "./notifications.types";

export type StoredNotification = {
  id: string; userId: string; type: NotificationType; category: NotificationCategory; title: string; body: string; actionUrl: string | null; entityType: string | null; entityId: string | null; metadata: NotificationMetadata; dedupeKey: string | null; aggregationKey: string | null; readAt: Date | null; deletedAt: Date | null; expiresAt: Date; createdAt: Date; updatedAt: Date;
};
export type OwnedNotificationMutation = { row: StoredNotification; changed: boolean };
export type NewNotification = Omit<StoredNotification, "id" | "updatedAt">;
export type AggregatePersistence = { row: StoredNotification; changed: boolean };
export type NotificationPersistence = {
  row: StoredNotification | null;
  changed: boolean;
  shouldSignal?: boolean;
};
export type MessageProjectionInput = {
  notification: NewNotification;
  messageId: string;
  conversationId: string;
  recipientId: string;
};
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
  create(input: NewNotification): Promise<StoredNotification>;
  persistAggregate(input: NewNotification & { aggregationKey: string }): Promise<AggregatePersistence | null>;
  persistMessageProjection?(input: MessageProjectionInput): Promise<NotificationPersistence>;
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
    const result = await this.persistFromEvent(type, payload, options);
    if (!result.row) return null;
    if (result.changed && result.shouldSignal !== false) await this.signal(result.row.userId, result.row.id);
    return toDto(result.row);
  }
  async persistMessageProjection(
    payload: Extract<NotificationEventPayload, { eventType: "MESSAGE_RECEIVED" }>,
    options: { dedupeKey: string }
  ): Promise<NotificationPersistence> {
    return this.persistFromEvent(NotificationType.MESSAGE_RECEIVED, payload, options);
  }
  async persistFromEvent(type: NotificationType, payload: NotificationEventPayload, options: { dedupeKey?: string; aggregationKey?: string } = {}): Promise<NotificationPersistence> {
    const rendered = renderNotification(type, payload); const preferences = await this.getPreferences(payload.recipientId);
    if (!preferences[rendered.category]) return { row: null, changed: false };
    const createdAt = this.now(); const expiresAt = new Date(createdAt.getTime() + 90 * 24 * 60 * 60 * 1000);
    const input: NewNotification = { userId: payload.recipientId, type, ...rendered, dedupeKey: options.dedupeKey ?? null, aggregationKey: options.aggregationKey ?? null, readAt: null, deletedAt: null, expiresAt, createdAt };
    if (
      type === NotificationType.MESSAGE_RECEIVED &&
      payload.eventType === NotificationType.MESSAGE_RECEIVED &&
      options.dedupeKey &&
      this.repo.persistMessageProjection
    ) {
      return this.repo.persistMessageProjection({
        notification: input,
        messageId: payload.messageId,
        conversationId: payload.conversationId,
        recipientId: payload.recipientId,
      });
    }
    if (options.dedupeKey) { const existing = await this.repo.findByDedupeKey(options.dedupeKey); if (existing) return { row: existing, changed: false }; }
    if (options.aggregationKey) {
      const result = await this.repo.persistAggregate({ ...input, aggregationKey: options.aggregationKey });
      if (!result) return { row: null, changed: false };
      return result;
    }
    let row: StoredNotification;
    try { row = await this.repo.create(input); }
    catch (error) {
      if (!options.dedupeKey || !isUniqueConflict(error)) throw error;
      const existing = await this.repo.findByDedupeKey(options.dedupeKey);
      if (!existing) throw error;
      return { row: existing, changed: false };
    }
    return { row, changed: true };
  }
  async signalPersisted(userId: string, notificationId: string, unreadCount?: number): Promise<void> { await this.publishSignal(userId, notificationId, unreadCount ?? await this.unreadCount(userId)); }
  private async signal(userId: string, notificationId: string): Promise<void> { await this.publishSignal(userId, notificationId, await this.unreadCount(userId)); }
}
function toDto(row: StoredNotification): NotificationDto { return { id: row.id, type: row.type, category: row.category, title: row.title, body: row.body, actionUrl: row.actionUrl, entityType: row.entityType, entityId: row.entityId, metadata: publicMetadata(row.metadata), readAt: row.readAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() }; }

const INTERNAL_METADATA_KEYS = new Set(["sourceTimestamp", "sourceId", "sourceVersion"]);
function publicMetadata(metadata: NotificationMetadata): NotificationMetadata {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !INTERNAL_METADATA_KEYS.has(key)));
}
function notFound(): AppError { return new AppError(404, "Notification not found.", "NOT_FOUND"); }
function isUniqueConflict(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002"; }
