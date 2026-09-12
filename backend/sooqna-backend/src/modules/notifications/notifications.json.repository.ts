import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  NotificationOutboxState,
  type NotificationCategory,
  type NotificationType,
} from "@prisma/client";
import { readJsonArrayFile, writeJsonArrayFileAtomically } from "../../utils/fileStore";
import { withFileLock } from "../../shared/database/fileLock";
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
import { decodeNotificationCursor, encodeNotificationCursor, type NotificationListQuery } from "./notifications.types";
import type {
  NotificationOutboxRecord,
  NotificationOutboxRepository,
} from "./notifications.worker";
import { isStaleAggregate, mergeSavedSearchAggregate } from "./notifications.aggregate";

type JsonNotificationState = {
  notifications: StoredNotification[];
  preferences: Array<{ userId: string; category: NotificationCategory; enabled: boolean }>;
};

export interface JsonNotificationsStore {
  mutateMessageState<T>(work: (state: JsonMessagesState) => Promise<T> | T): Promise<T>;
  readNotificationState(): Promise<JsonNotificationState>;
  mutateNotificationState<T>(work: (state: JsonNotificationState) => Promise<T> | T): Promise<T>;
}

const notificationStatePath = path.resolve(
  process.cwd(),
  "src/modules/notifications/notifications-state.data.json"
);
const notificationStateLockPath = `${notificationStatePath}.lock`;
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
  async readNotificationState() {
    const stored = readJsonArrayFile<JsonNotificationState>(notificationStatePath)[0];
    return stored
      ? { ...stored, notifications: stored.notifications.map(hydrateNotification) }
      : { notifications: [], preferences: [] };
  },
  mutateNotificationState<T>(work: (state: JsonNotificationState) => Promise<T> | T) {
    const run = async () => {
      const state = await fileStore.readNotificationState();
      const result = await work(state);
      writeJsonArrayFileAtomically(notificationStatePath, [state]);
      return result;
    };
    const lockedRun = () => withFileLock(notificationStateLockPath, run);
    const result = notificationStateQueue.then(lockedRun, lockedRun);
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

  async listActive(userId: string, query: NotificationListQuery, now: Date) {
    const state = await this.store.readNotificationState();
      let rows = state.notifications.filter((row) => row.userId === userId && !row.deletedAt && row.expiresAt > now);
      if (query.category) rows = rows.filter((row) => row.category === query.category);
      if (query.unread !== undefined) rows = rows.filter((row) => query.unread ? !row.readAt : Boolean(row.readAt));
      if (query.cursor) {
        const cursor = decodeNotificationCursor(query.cursor);
        const cursorDate = new Date(cursor.createdAt);
        rows = rows.filter((row) =>
          row.createdAt < cursorDate ||
          (row.createdAt.getTime() === cursorDate.getTime() && row.id < cursor.id)
        );
      }
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
      const items = rows.slice(0, query.limit);
      const hasMore = rows.length > query.limit;
      const last = items.at(-1);
      return {
        items,
        hasMore,
        nextCursor: hasMore && last
          ? encodeNotificationCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
      };
  }

  async countUnread(userId: string, now: Date) { const state = await this.store.readNotificationState(); return state.notifications.filter((row) => row.userId === userId && !row.readAt && !row.deletedAt && row.expiresAt > now).length; }
  async findActiveOwned(userId: string, id: string, now: Date) { const state = await this.store.readNotificationState(); return state.notifications.find((row) => row.id === id && row.userId === userId && !row.deletedAt && row.expiresAt > now) ?? null; }
  markReadOwned(userId: string, id: string, now: Date) { return this.store.mutateNotificationState((state): OwnedNotificationMutation | null => { const row = state.notifications.find((item) => item.id === id && item.userId === userId && !item.deletedAt && item.expiresAt > now); if (!row) return null; const changed = !row.readAt; if (changed) { row.readAt = now; row.updatedAt = now; } return { row, changed }; }); }
  markAllRead(userId: string, now: Date) { return this.store.mutateNotificationState((state) => { let count = 0; for (const row of state.notifications) if (row.userId === userId && !row.readAt && !row.deletedAt && row.expiresAt > now) { row.readAt = now; row.updatedAt = now; count += 1; } return count; }); }
  softDeleteOwned(userId: string, id: string, now: Date) { return this.store.mutateNotificationState((state): OwnedNotificationMutation | null => { const row = state.notifications.find((item) => item.id === id && item.userId === userId && item.expiresAt > now); if (!row) return null; if (row.deletedAt) return { row, changed: false }; row.deletedAt = now; row.updatedAt = now; return { row, changed: true }; }); }
  async getPreferences(userId: string) { const state = await this.store.readNotificationState(); return state.preferences.filter((row) => row.userId === userId).map(({ category, enabled }) => ({ category, enabled })); }
  upsertPreferences(userId: string, values: Partial<Record<NotificationCategory, boolean>>) { return this.store.mutateNotificationState((state) => { for (const [category, enabled] of Object.entries(values)) { const existing = state.preferences.find((row) => row.userId === userId && row.category === category); if (existing) existing.enabled = Boolean(enabled); else state.preferences.push({ userId, category: category as NotificationCategory, enabled: Boolean(enabled) }); } return state.preferences.filter((row) => row.userId === userId).map(({ category, enabled }) => ({ category, enabled })); }); }
  async findByDedupeKey(dedupeKey: string) { const state = await this.store.readNotificationState(); return state.notifications.find((row) => row.dedupeKey === dedupeKey) ?? null; }
  async findCurrentAggregate(aggregationKey: string) { const state = await this.store.readNotificationState(); return state.notifications.find((row) => row.aggregationKey === aggregationKey && !row.deletedAt) ?? null; }
  create(input: NewNotification) { return this.store.mutateNotificationState((state) => { const row: StoredNotification = { ...input, id: `ntf_${randomUUID()}`, updatedAt: input.createdAt }; state.notifications.push(row); return row; }); }
  persistAggregate(input: NewNotification & { aggregationKey: string }) { return this.store.mutateNotificationState((state): AggregatePersistence => { const existing = state.notifications.find((row) => row.userId === input.userId && row.aggregationKey === input.aggregationKey && !row.deletedAt); if (existing) { if (isStaleAggregate(input.type, existing.metadata, input.metadata)) return { row: existing, changed: false }; const merged = input.type === "SAVED_SEARCH_MATCHES" ? mergeSavedSearchInput(input, existing.metadata) : input; Object.assign(existing, merged, { updatedAt: input.createdAt, readAt: null }); return { row: existing, changed: true }; } const row: StoredNotification = { ...input, id: `ntf_${randomUUID()}`, updatedAt: input.createdAt }; state.notifications.push(row); return { row, changed: true }; }); }
  updateAggregate(id: string, input: Partial<Pick<StoredNotification, "title" | "body" | "actionUrl" | "metadata" | "expiresAt" | "updatedAt">>) { return this.store.mutateNotificationState((state) => { const row = state.notifications.find((item) => item.id === id); if (!row) throw new Error("Notification not found"); Object.assign(row, input, { readAt: null }); return row; }); }
}

function mergeSavedSearchInput(input: NewNotification, current: Record<string, string | number | string[]>): NewNotification {
  const metadata = mergeSavedSearchAggregate(current, input.metadata);
  const total = typeof metadata.totalCount === "number" ? metadata.totalCount : 0;
  const name = typeof metadata.savedSearchName === "string" ? metadata.savedSearchName : "";
  return { ...input, metadata, body: `وجدنا ${total} نتيجة جديدة لبحث «${name}».` };
}
