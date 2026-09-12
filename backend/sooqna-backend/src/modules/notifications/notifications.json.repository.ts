import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  NotificationOutboxState,
  type NotificationCategory,
  type NotificationType,
} from "@prisma/client";
import { readJsonArrayFile, writeJsonArrayFileAtomically } from "../../utils/fileStore";
import {
  mutateJsonMessageFallbackState,
  type JsonMessagesState,
} from "../messages/repositories/messages.repository";
import type {
  AggregatePersistence,
  NewNotification,
  NotificationsRepository,
  OwnedNotificationMutation,
  StoredNotification,
} from "./notifications.service";
import type { NotificationListQuery } from "./notifications.types";
import type {
  NotificationOutboxRecord,
  NotificationOutboxRepository,
} from "./notifications.worker";

type JsonNotificationState = {
  notifications: StoredNotification[];
  preferences: Array<{ userId: string; category: NotificationCategory; enabled: boolean }>;
};

export interface JsonNotificationsStore {
  mutateMessageState<T>(work: (state: JsonMessagesState) => Promise<T> | T): Promise<T>;
  mutateNotificationState<T>(work: (state: JsonNotificationState) => Promise<T> | T): Promise<T>;
}

const notificationStatePath = path.resolve(
  process.cwd(),
  "src/modules/notifications/notifications-state.data.json"
);
let notificationStateQueue: Promise<void> = Promise.resolve();

function hydrateNotification(row: StoredNotification): StoredNotification {
  return {
    ...row,
    readAt: row.readAt ? new Date(row.readAt) : null,
    deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
    expiresAt: new Date(row.expiresAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

const fileStore: JsonNotificationsStore = {
  mutateMessageState: mutateJsonMessageFallbackState,
  mutateNotificationState<T>(work: (state: JsonNotificationState) => Promise<T> | T) {
    const run = async () => {
      const stored = readJsonArrayFile<JsonNotificationState>(notificationStatePath)[0];
      const state: JsonNotificationState = stored
        ? { ...stored, notifications: stored.notifications.map(hydrateNotification) }
        : { notifications: [], preferences: [] };
      const result = await work(state);
      writeJsonArrayFileAtomically(notificationStatePath, [state]);
      return result;
    };
    const result = notificationStateQueue.then(run, run);
    notificationStateQueue = result.then(() => undefined, () => undefined);
    return result;
  },
};

type JsonOutbox = Record<string, unknown>;
function outboxRecord(row: JsonOutbox): NotificationOutboxRecord {
  return {
    id: String(row.id),
    eventType: row.eventType as NotificationType,
    aggregateType: String(row.aggregateType),
    aggregateId: String(row.aggregateId),
    recipientId: typeof row.recipientId === "string" ? row.recipientId : null,
    payload: row.payload,
    dedupeKey: String(row.dedupeKey),
    state: row.state as NotificationOutboxState,
    attempts: Number(row.attempts),
    availableAt: new Date(String(row.availableAt)),
    processedAt: row.processedAt ? new Date(String(row.processedAt)) : null,
    lastError: typeof row.lastError === "string" ? row.lastError : null,
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
    claimAttempt: Number(row.attempts),
  };
}

export class JsonNotificationsRepository
  implements NotificationsRepository, NotificationOutboxRepository
{
  constructor(private readonly store: JsonNotificationsStore = fileStore) {}

  recoverStaleProcessing(now: Date, staleBefore: Date) {
    return this.store.mutateMessageState((state) => {
      const dead: Array<{ id: string; attempts: number }> = [];
      let recovered = 0;
      for (const row of state.notificationOutbox) {
        if (row.state !== NotificationOutboxState.PROCESSING || new Date(String(row.updatedAt)) >= staleBefore) continue;
        recovered += 1;
        if (Number(row.attempts) >= 8) {
          row.state = NotificationOutboxState.DEAD;
          dead.push({ id: String(row.id), attempts: Number(row.attempts) });
        } else {
          row.state = NotificationOutboxState.FAILED;
          row.availableAt = now.toISOString();
        }
        row.updatedAt = now.toISOString();
      }
      return { recovered, dead };
    });
  }

  claimReady(limit: number, now: Date) {
    return this.store.mutateMessageState((state) => {
      const rows = state.notificationOutbox
        .filter((row) =>
          (row.state === NotificationOutboxState.PENDING || row.state === NotificationOutboxState.FAILED) &&
          Number(row.attempts) < 8 && new Date(String(row.availableAt)) <= now
        )
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .slice(0, Math.max(1, Math.min(limit, 200)));
      for (const row of rows) {
        row.state = NotificationOutboxState.PROCESSING;
        row.attempts = Number(row.attempts) + 1;
        row.updatedAt = now.toISOString();
      }
      return rows.map(outboxRecord);
    });
  }

  markProcessed(id: string, claimAttempt: number, now: Date) {
    return this.store.mutateMessageState((state) => {
      const row = state.notificationOutbox.find((item) => item.id === id);
      if (!row || row.state !== NotificationOutboxState.PROCESSING || Number(row.attempts) !== claimAttempt) return false;
      row.state = NotificationOutboxState.PROCESSED;
      row.processedAt = now.toISOString();
      row.lastError = null;
      row.updatedAt = now.toISOString();
      return true;
    });
  }

  markFailure(id: string, claimAttempt: number, error: string, availableAt: Date, now: Date) {
    return this.store.mutateMessageState((state) => {
      const row = state.notificationOutbox.find((item) => item.id === id);
      if (!row || row.state !== NotificationOutboxState.PROCESSING || Number(row.attempts) !== claimAttempt) return NotificationOutboxState.PROCESSING;
      row.state = claimAttempt >= 8 ? NotificationOutboxState.DEAD : NotificationOutboxState.FAILED;
      row.lastError = error.slice(0, 500);
      row.availableAt = availableAt.toISOString();
      row.updatedAt = now.toISOString();
      return row.state as NotificationOutboxState;
    });
  }

  listActive(userId: string, query: NotificationListQuery, now: Date) {
    return this.store.mutateNotificationState((state) => {
      let rows = state.notifications.filter((row) => row.userId === userId && !row.deletedAt && row.expiresAt > now);
      if (query.category) rows = rows.filter((row) => row.category === query.category);
      if (query.unread !== undefined) rows = rows.filter((row) => query.unread ? !row.readAt : Boolean(row.readAt));
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
      const items = rows.slice(0, query.limit);
      return { items, hasMore: rows.length > query.limit, nextCursor: null };
    });
  }

  countUnread(userId: string, now: Date) { return this.store.mutateNotificationState((state) => state.notifications.filter((row) => row.userId === userId && !row.readAt && !row.deletedAt && row.expiresAt > now).length); }
  findActiveOwned(userId: string, id: string, now: Date) { return this.store.mutateNotificationState((state) => state.notifications.find((row) => row.id === id && row.userId === userId && !row.deletedAt && row.expiresAt > now) ?? null); }
  markReadOwned(userId: string, id: string, now: Date) { return this.store.mutateNotificationState((state): OwnedNotificationMutation | null => { const row = state.notifications.find((item) => item.id === id && item.userId === userId && !item.deletedAt && item.expiresAt > now); if (!row) return null; const changed = !row.readAt; if (changed) { row.readAt = now; row.updatedAt = now; } return { row, changed }; }); }
  markAllRead(userId: string, now: Date) { return this.store.mutateNotificationState((state) => { let count = 0; for (const row of state.notifications) if (row.userId === userId && !row.readAt && !row.deletedAt && row.expiresAt > now) { row.readAt = now; row.updatedAt = now; count += 1; } return count; }); }
  softDeleteOwned(userId: string, id: string, now: Date) { return this.store.mutateNotificationState((state): OwnedNotificationMutation | null => { const row = state.notifications.find((item) => item.id === id && item.userId === userId && !item.deletedAt && item.expiresAt > now); if (!row) return null; row.deletedAt = now; row.updatedAt = now; return { row, changed: true }; }); }
  getPreferences(userId: string) { return this.store.mutateNotificationState((state) => state.preferences.filter((row) => row.userId === userId).map(({ category, enabled }) => ({ category, enabled }))); }
  upsertPreferences(userId: string, values: Partial<Record<NotificationCategory, boolean>>) { return this.store.mutateNotificationState((state) => { for (const [category, enabled] of Object.entries(values)) { const existing = state.preferences.find((row) => row.userId === userId && row.category === category); if (existing) existing.enabled = Boolean(enabled); else state.preferences.push({ userId, category: category as NotificationCategory, enabled: Boolean(enabled) }); } return state.preferences.filter((row) => row.userId === userId).map(({ category, enabled }) => ({ category, enabled })); }); }
  findByDedupeKey(dedupeKey: string) { return this.store.mutateNotificationState((state) => state.notifications.find((row) => row.dedupeKey === dedupeKey) ?? null); }
  findCurrentAggregate(aggregationKey: string) { return this.store.mutateNotificationState((state) => state.notifications.find((row) => row.aggregationKey === aggregationKey && !row.deletedAt) ?? null); }
  create(input: NewNotification) { return this.store.mutateNotificationState((state) => { const row: StoredNotification = { ...input, id: `ntf_${randomUUID()}`, updatedAt: input.createdAt }; state.notifications.push(row); return row; }); }
  persistAggregate(input: NewNotification & { aggregationKey: string }) { return this.store.mutateNotificationState((state): AggregatePersistence => { const existing = state.notifications.find((row) => row.userId === input.userId && row.aggregationKey === input.aggregationKey && !row.deletedAt); if (existing) { Object.assign(existing, input, { updatedAt: input.createdAt, readAt: null }); return { row: existing, changed: true }; } const row: StoredNotification = { ...input, id: `ntf_${randomUUID()}`, updatedAt: input.createdAt }; state.notifications.push(row); return { row, changed: true }; }); }
  updateAggregate(id: string, input: Partial<Pick<StoredNotification, "title" | "body" | "actionUrl" | "metadata" | "expiresAt" | "updatedAt">>) { return this.store.mutateNotificationState((state) => { const row = state.notifications.find((item) => item.id === id); if (!row) throw new Error("Notification not found"); Object.assign(row, input, { readAt: null }); return row; }); }
}
