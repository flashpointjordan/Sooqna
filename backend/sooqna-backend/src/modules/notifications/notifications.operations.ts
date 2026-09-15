import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  NotificationBroadcastAudience,
  NotificationBroadcastStatus,
  NotificationOutboxState,
  NotificationType,
  Prisma,
  Role,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { logAuditEvent } from "../audit/audit.service";
import { readJsonArrayFile, writeJsonArrayFileAtomically } from "../../utils/fileStore";
import { withMarketplaceJsonLock } from "../../shared/database/marketplaceJsonLock";
import {
  commitNotificationBroadcastJournalUnlocked,
  messagesStateDataPath,
  notificationBroadcastJournalPath,
  notificationOperationsDataPath,
  recoverMarketplaceJsonJournalsUnlocked,
  recoverNotificationBroadcastJournalUnlocked,
  type JsonBroadcastFanoutJournal,
} from "../../shared/database/marketplaceJsonRecovery";
import {
  readJsonMessageFallbackStateUnlocked,
  type JsonMessagesState,
} from "../messages/repositories/messages.repository";
import {
  commitJsonConversationReadUnlocked,
  readJsonNotificationStateUnlocked,
} from "../messages/repositories/conversationReadJsonCoordinator";

export type NotificationBroadcastAudienceValue = { roles?: Role[]; userIds?: string[] };

export type NotificationBroadcastInput = {
  audience: NotificationBroadcastAudience | keyof typeof NotificationBroadcastAudience;
  audienceValue: NotificationBroadcastAudienceValue | null;
  title: string;
  body: string;
  actionUrl?: string | null;
  createdBy: string;
};

export type StoredNotificationBroadcast = NotificationBroadcastInput & {
  id: string;
  status: NotificationBroadcastStatus;
  cursor: string | null;
  deliveredCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type NotificationCleanupResult = {
  notifications: number;
  processedOutbox: number;
  deadOutbox: number;
  aggregateLedgerKeys: number;
  hasMore: boolean;
};

type JsonCleanupNotificationState = {
  notifications: Array<{ expiresAt: string | Date; deletedAt?: string | Date | null }>;
  appliedAggregateEventKeys?: string[];
};

export function cleanupJsonNotificationState(
  messageState: JsonMessagesState,
  notificationState: JsonCleanupNotificationState,
  now: Date,
  limit: number
): NotificationCleanupResult {
  const expired = notificationState.notifications
    .filter((row) => Boolean(row.deletedAt) || new Date(row.expiresAt) <= now)
    .slice(0, limit);
  const processedBefore = now.getTime() - 14 * 24 * 60 * 60_000;
  const deadBefore = now.getTime() - 30 * 24 * 60 * 60_000;
  const processed = messageState.notificationOutbox
    .filter((row) => row.state === NotificationOutboxState.PROCESSED && row.processedAt && new Date(String(row.processedAt)).getTime() < processedBefore)
    .slice(0, limit);
  const dead = messageState.notificationOutbox
    .filter((row) => row.state === NotificationOutboxState.DEAD && new Date(String(row.updatedAt)).getTime() < deadBefore)
    .slice(0, limit);
  const removedKeys = new Set([...processed, ...dead].map((row) => String(row.dedupeKey)));
  const previousLedger = notificationState.appliedAggregateEventKeys ?? [];
  notificationState.notifications = notificationState.notifications.filter((row) => !expired.includes(row));
  messageState.notificationOutbox = messageState.notificationOutbox.filter((row) => !processed.includes(row) && !dead.includes(row));
  notificationState.appliedAggregateEventKeys = previousLedger.filter((key) => !removedKeys.has(key));
  return {
    notifications: expired.length,
    processedOutbox: processed.length,
    deadOutbox: dead.length,
    aggregateLedgerKeys: previousLedger.length - notificationState.appliedAggregateEventKeys.length,
    hasMore: expired.length === limit || processed.length === limit || dead.length === limit,
  };
}

export type NotificationQueueHealth = {
  queueDepth: number;
  oldestPendingAgeMs: number | null;
  deadCount: number;
};

export type NotificationOperationsRepository = {
  createBroadcast(input: NotificationBroadcastInput, now: Date): Promise<StoredNotificationBroadcast>;
  processBroadcastBatch(limit: number, now: Date): Promise<{ broadcastId: string | null; enqueued: number; completed: boolean }>;
  cleanupBatch(now: Date, limit: number): Promise<NotificationCleanupResult>;
  health(now: Date): Promise<NotificationQueueHealth>;
};

type OperationsOptions = {
  now?: () => Date;
  audit?: typeof logAuditEvent;
};

export class NotificationOperationsService {
  private readonly now: () => Date;
  private readonly audit: typeof logAuditEvent;

  constructor(private readonly repository: NotificationOperationsRepository, options: OperationsOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.audit = options.audit ?? logAuditEvent;
  }

  async createBroadcast(createdBy: string, input: Omit<NotificationBroadcastInput, "createdBy">): Promise<StoredNotificationBroadcast> {
    const row = await this.repository.createBroadcast({ ...input, createdBy }, this.now());
    await this.audit({
      actorId: createdBy,
      action: "admin.notification.broadcast",
      targetType: "notification_broadcast",
      targetId: row.id,
      metadata: { audience: row.audience },
    });
    return row;
  }

  processBroadcastBatch(limit = 100) {
    return this.repository.processBroadcastBatch(Math.max(1, Math.min(limit, 200)), this.now());
  }

  cleanupBatch(limit = 200) {
    return this.repository.cleanupBatch(this.now(), Math.max(1, Math.min(limit, 500)));
  }

  async health(runtime: { workerState: NotificationWorkerState; operationsSchedulerState: NotificationWorkerState; activeStreams: number }) {
    return { ...(await this.repository.health(this.now())), ...runtime };
  }
}

export type NotificationWorkerState = "idle" | "running" | "stopping" | "stopped" | "error";
let productionOperationsWorkerState: NotificationWorkerState = "idle";
export function setNotificationOperationsWorkerState(state: NotificationWorkerState): void { productionOperationsWorkerState = state; }
export function getNotificationOperationsWorkerState(): NotificationWorkerState { return productionOperationsWorkerState; }

export function createNotificationOperationsScheduler(deps: {
  service: Pick<NotificationOperationsService, "processBroadcastBatch" | "cleanupBatch">;
  intervalMs?: number;
  now?: () => Date;
  logger?: { error(message: string, metadata?: Record<string, unknown>): void };
}) {
  const intervalMs = Math.max(100, deps.intervalMs ?? 1_000);
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let state: NotificationWorkerState = "idle";
  let cleanedUtcDay: string | undefined;

  const execute = async () => {
    state = "running";
    setNotificationOperationsWorkerState(state);
    try {
      await deps.service.processBroadcastBatch();
      const utcDay = now().toISOString().slice(0, 10);
      if (cleanedUtcDay !== utcDay) {
        const result = await deps.service.cleanupBatch();
        if (!result.hasMore) cleanedUtcDay = utcDay;
      }
      state = timer ? "running" : "idle";
      setNotificationOperationsWorkerState(state);
    } catch (error) {
      state = "error";
      setNotificationOperationsWorkerState(state);
      deps.logger?.error("Notification operations run failed.", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  const runOnce = async () => {
    if (state === "stopping" || state === "stopped") return;
    if (active) return active;
    active = execute();
    try { await active; } finally { active = undefined; }
  };
  const schedule = () => { void runOnce(); };
  return {
    runOnce,
    start() {
      if (timer) return;
      state = "running";
      setNotificationOperationsWorkerState(state);
      schedule();
      timer = setInterval(schedule, intervalMs);
      timer.unref();
    },
    async stop() {
      state = "stopping";
      setNotificationOperationsWorkerState(state);
      if (timer) clearInterval(timer);
      timer = undefined;
      await active;
      state = "stopped";
      setNotificationOperationsWorkerState(state);
    },
    health: () => ({ state }),
  };
}

function audienceValue(value: Prisma.JsonValue): NotificationBroadcastAudienceValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return {
    ...(Array.isArray(source.roles) ? { roles: source.roles.filter((role): role is Role => typeof role === "string") as Role[] } : {}),
    ...(Array.isArray(source.userIds) ? { userIds: source.userIds.filter((id): id is string => typeof id === "string") } : {}),
  };
}

function storedBroadcast(row: {
  id: string; audience: NotificationBroadcastAudience; audienceValue: Prisma.JsonValue; title: string; body: string;
  actionUrl: string | null; status: NotificationBroadcastStatus; cursor: string | null; deliveredCount: number; createdBy: string;
  createdAt: Date; updatedAt: Date;
}): StoredNotificationBroadcast {
  return { ...row, audienceValue: audienceValue(row.audienceValue) };
}

export class PrismaNotificationOperationsRepository implements NotificationOperationsRepository {
  async createBroadcast(input: NotificationBroadcastInput, now: Date) {
    return storedBroadcast(await prisma.notificationBroadcast.create({
      data: {
        audience: input.audience as NotificationBroadcastAudience,
        audienceValue: (input.audienceValue ?? {}) as Prisma.InputJsonValue,
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl ?? null,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      },
    }));
  }

  async processBroadcastBatch(limit: number, now: Date) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('notification-broadcast-fanout'))`);
      const broadcast = await tx.notificationBroadcast.findFirst({
        where: { status: { in: [NotificationBroadcastStatus.PENDING, NotificationBroadcastStatus.PROCESSING, NotificationBroadcastStatus.FAILED] } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (!broadcast) return { broadcastId: null, enqueued: 0, completed: true };
      if (broadcast.status !== NotificationBroadcastStatus.PROCESSING) {
        await tx.notificationBroadcast.update({ where: { id: broadcast.id }, data: { status: NotificationBroadcastStatus.PROCESSING } });
      }
      const value = audienceValue(broadcast.audienceValue);
      const audienceFilters: Prisma.UserWhereInput[] = [];
      if (broadcast.cursor) audienceFilters.push({ firebaseUid: { gt: broadcast.cursor } });
      if (broadcast.audience === NotificationBroadcastAudience.ROLES) audienceFilters.push({ role: { in: value.roles ?? [] } });
      if (broadcast.audience === NotificationBroadcastAudience.USERS) audienceFilters.push({ firebaseUid: { in: value.userIds ?? [] } });
      const rows = await tx.user.findMany({
        where: {
          accountStatus: "active",
          ...(audienceFilters.length > 0 ? { AND: audienceFilters } : {}),
        },
        select: { firebaseUid: true },
        orderBy: { firebaseUid: "asc" },
        take: limit + 1,
      });
      const recipients = rows.slice(0, limit);
      for (const recipient of recipients) {
        const dedupeKey = `broadcast:${broadcast.id}:${recipient.firebaseUid}`;
        await tx.notificationOutbox.upsert({
          where: { dedupeKey },
          create: {
            eventType: NotificationType.SYSTEM_ANNOUNCEMENT,
            aggregateType: "notification_broadcast",
            aggregateId: broadcast.id,
            recipientId: recipient.firebaseUid,
            payload: {
              eventType: NotificationType.SYSTEM_ANNOUNCEMENT,
              recipientId: recipient.firebaseUid,
              announcementId: broadcast.id,
              title: broadcast.title,
              body: broadcast.body,
              actionUrl: broadcast.actionUrl,
            },
            dedupeKey,
            state: NotificationOutboxState.PENDING,
            attempts: 0,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
          },
          update: {},
        });
      }
      const completed = rows.length <= limit;
      await tx.notificationBroadcast.update({
        where: { id: broadcast.id },
        data: {
          cursor: recipients.at(-1)?.firebaseUid ?? broadcast.cursor,
          deliveredCount: { increment: recipients.length },
          status: completed ? NotificationBroadcastStatus.COMPLETED : NotificationBroadcastStatus.PROCESSING,
          updatedAt: now,
        },
      });
      return { broadcastId: broadcast.id, enqueued: recipients.length, completed };
    });
  }

  async cleanupBatch(now: Date, limit: number): Promise<NotificationCleanupResult> {
    const processedBefore = new Date(now.getTime() - 14 * 24 * 60 * 60_000);
    const deadBefore = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    return prisma.$transaction(async (tx) => {
      const [notifications, processed, dead] = await Promise.all([
        tx.notification.findMany({ where: { OR: [{ expiresAt: { lte: now } }, { deletedAt: { not: null } }] }, select: { id: true }, orderBy: { id: "asc" }, take: limit }),
        tx.notificationOutbox.findMany({ where: { state: NotificationOutboxState.PROCESSED, processedAt: { lt: processedBefore } }, select: { id: true }, orderBy: { id: "asc" }, take: limit }),
        tx.notificationOutbox.findMany({ where: { state: NotificationOutboxState.DEAD, updatedAt: { lt: deadBefore } }, select: { id: true }, orderBy: { id: "asc" }, take: limit }),
      ]);
      const [notificationDelete, processedDelete, deadDelete] = await Promise.all([
        tx.notification.deleteMany({ where: { id: { in: notifications.map((row) => row.id) } } }),
        tx.notificationOutbox.deleteMany({ where: { id: { in: processed.map((row) => row.id) } } }),
        tx.notificationOutbox.deleteMany({ where: { id: { in: dead.map((row) => row.id) } } }),
      ]);
      return {
        notifications: notificationDelete.count,
        processedOutbox: processedDelete.count,
        deadOutbox: deadDelete.count,
        aggregateLedgerKeys: 0,
        hasMore: notifications.length === limit || processed.length === limit || dead.length === limit,
      };
    });
  }

  async health(now: Date): Promise<NotificationQueueHealth> {
    const readyStates = [NotificationOutboxState.PENDING, NotificationOutboxState.FAILED, NotificationOutboxState.PROCESSING];
    const [queueDepth, oldest, deadCount] = await Promise.all([
      prisma.notificationOutbox.count({ where: { state: { in: readyStates } } }),
      prisma.notificationOutbox.findFirst({ where: { state: { in: readyStates } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      prisma.notificationOutbox.count({ where: { state: NotificationOutboxState.DEAD } }),
    ]);
    return { queueDepth, oldestPendingAgeMs: oldest ? Math.max(0, now.getTime() - oldest.createdAt.getTime()) : null, deadCount };
  }
}

type JsonBroadcastState = { broadcasts: Array<Omit<StoredNotificationBroadcast, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string }> };
type JsonUser = { uid?: string; firebaseUid?: string; role?: unknown; accountStatus?: string };
const jsonOperationsPath = notificationOperationsDataPath;
const jsonUsersPath = path.resolve(process.cwd(), "src/modules/users/repositories/users.data.json");
const jsonMessagesPath = messagesStateDataPath;
const jsonBroadcastJournalPath = notificationBroadcastJournalPath;

export type JsonNotificationOperationsPaths = {
  operations: string;
  users: string;
  messages: string;
  journal: string;
};

export type JsonNotificationOperationsStorage = {
  recover(): void;
  readOperations(): JsonBroadcastState;
  readUsers(): JsonUser[];
  readMessages(): JsonMessagesState;
  commitFanout(journal: JsonBroadcastFanoutJournal): void;
  writeOperations(operations: JsonBroadcastState): void;
};

export function createJsonNotificationOperationsStorage(options: {
  paths?: JsonNotificationOperationsPaths;
  write?: (filePath: string, records: unknown[]) => void;
} = {}): JsonNotificationOperationsStorage {
  const paths = options.paths ?? {
    operations: jsonOperationsPath,
    users: jsonUsersPath,
    messages: jsonMessagesPath,
    journal: jsonBroadcastJournalPath,
  };
  const write = options.write ?? ((filePath: string, records: unknown[]) => writeJsonArrayFileAtomically(filePath, records));
  const recover = (): void => {
    if (!options.paths) {
      recoverMarketplaceJsonJournalsUnlocked();
      return;
    }
    recoverNotificationBroadcastJournalUnlocked({
      messages: paths.messages,
      operations: paths.operations,
      broadcastJournal: paths.journal,
    }, write);
  };
  return {
    recover,
    readOperations() {
      return readJsonArrayFile<JsonBroadcastState>(paths.operations)[0] ?? { broadcasts: [] };
    },
    readUsers() {
      return readJsonArrayFile<JsonUser>(paths.users);
    },
    readMessages() {
      if (!options.paths) return readJsonMessageFallbackStateUnlocked();
      return readJsonArrayFile<JsonMessagesState>(paths.messages)[0] ?? { conversations: [], messages: [], notificationOutbox: [] };
    },
    commitFanout(journal) {
      commitNotificationBroadcastJournalUnlocked(journal, {
        messages: paths.messages,
        operations: paths.operations,
        broadcastJournal: paths.journal,
      }, write);
    },
    writeOperations(operations) {
      write(paths.operations, [operations]);
    },
  };
}

function normalizeJsonRole(value: unknown): Role | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === "USER") return Role.BUYER;
  return Object.values(Role).includes(normalized as Role) ? normalized as Role : undefined;
}

export class JsonNotificationOperationsRepository implements NotificationOperationsRepository {
  constructor(private readonly storage: JsonNotificationOperationsStorage = createJsonNotificationOperationsStorage()) {}

  async createBroadcast(input: NotificationBroadcastInput, now: Date) {
    return withMarketplaceJsonLock(() => {
      this.storage.recover();
      const state = this.storage.readOperations();
      const row: StoredNotificationBroadcast = { id: `broadcast_${randomUUID()}`, ...input, status: NotificationBroadcastStatus.PENDING, cursor: null, deliveredCount: 0, createdAt: now, updatedAt: now };
      state.broadcasts.push({ ...row, createdAt: now.toISOString(), updatedAt: now.toISOString() });
      this.storage.writeOperations(state);
      return row;
    });
  }

  async processBroadcastBatch(limit: number, now: Date) {
    return withMarketplaceJsonLock(() => {
      this.storage.recover();
      const state = this.storage.readOperations();
      const stored = state.broadcasts.find((row) => row.status !== NotificationBroadcastStatus.COMPLETED);
      if (!stored) return { broadcastId: null, enqueued: 0, completed: true };
      const baseOperations = structuredClone(state);
      const expectedCursor = stored.cursor;
      const expectedDeliveredCount = stored.deliveredCount;
      stored.status = NotificationBroadcastStatus.PROCESSING;
      const users = this.storage.readUsers()
        .map((user) => ({ firebaseUid: user.firebaseUid ?? user.uid ?? "", role: normalizeJsonRole(user.role), accountStatus: user.accountStatus ?? "active" }))
        .filter((user) => user.firebaseUid && user.accountStatus === "active")
        .filter((user) => !stored.cursor || user.firebaseUid > stored.cursor)
        .filter((user) => stored.audience !== NotificationBroadcastAudience.ROLES || Boolean(user.role && stored.audienceValue?.roles?.includes(user.role)))
        .filter((user) => stored.audience !== NotificationBroadcastAudience.USERS || Boolean(stored.audienceValue?.userIds?.includes(user.firebaseUid)))
        .sort((a, b) => a.firebaseUid.localeCompare(b.firebaseUid));
      const recipients = users.slice(0, limit);
      const messageState = this.storage.readMessages();
      const baseMessages = structuredClone(messageState);
      const outboxEntries: Array<Record<string, unknown>> = [];
      for (const recipient of recipients) {
        const dedupeKey = `broadcast:${stored.id}:${recipient.firebaseUid}`;
        if (messageState.notificationOutbox.some((row) => row.dedupeKey === dedupeKey)) continue;
        const outboxEntry = {
          id: `outbox_${randomUUID()}`,
          eventType: NotificationType.SYSTEM_ANNOUNCEMENT,
          aggregateType: "notification_broadcast",
          aggregateId: stored.id,
          recipientId: recipient.firebaseUid,
          payload: { eventType: NotificationType.SYSTEM_ANNOUNCEMENT, recipientId: recipient.firebaseUid, announcementId: stored.id, title: stored.title, body: stored.body, actionUrl: stored.actionUrl ?? null },
          dedupeKey,
          state: NotificationOutboxState.PENDING,
          attempts: 0,
          availableAt: now.toISOString(),
          notificationAppliedAt: null,
          processedAt: null,
          lastError: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        messageState.notificationOutbox.push(outboxEntry);
        outboxEntries.push(outboxEntry);
      }
      stored.cursor = recipients.at(-1)?.firebaseUid ?? stored.cursor;
      stored.deliveredCount += recipients.length;
      const completed = users.length <= limit;
      stored.status = completed ? NotificationBroadcastStatus.COMPLETED : NotificationBroadcastStatus.PROCESSING;
      stored.updatedAt = now.toISOString();
      this.storage.commitFanout({
        version: 2,
        baseMessages,
        baseOperations,
        outboxEntries,
        progress: {
          broadcastId: stored.id,
          expectedCursor,
          expectedDeliveredCount,
          nextCursor: stored.cursor,
          nextDeliveredCount: stored.deliveredCount,
          nextStatus: stored.status,
          updatedAt: stored.updatedAt,
        },
      });
      return { broadcastId: stored.id, enqueued: recipients.length, completed };
    });
  }

  async cleanupBatch(now: Date, limit: number): Promise<NotificationCleanupResult> {
    return withMarketplaceJsonLock(() => {
      this.storage.recover();
      const messageState = readJsonMessageFallbackStateUnlocked();
      const notificationState = readJsonNotificationStateUnlocked();
      const result = cleanupJsonNotificationState(messageState, notificationState, now, limit);
      commitJsonConversationReadUnlocked(messageState, notificationState);
      return result;
    });
  }

  async health(now: Date): Promise<NotificationQueueHealth> {
    const rows = this.storage.readMessages().notificationOutbox;
    const queuedStates = new Set<string>([NotificationOutboxState.PENDING, NotificationOutboxState.FAILED, NotificationOutboxState.PROCESSING]);
    const queued = rows.filter((row) => queuedStates.has(String(row.state)));
    const oldest = queued.reduce<number | null>((value, row) => {
      const createdAt = new Date(String(row.createdAt)).getTime();
      return value === null || createdAt < value ? createdAt : value;
    }, null);
    return {
      queueDepth: queued.length,
      oldestPendingAgeMs: oldest === null ? null : Math.max(0, now.getTime() - oldest),
      deadCount: rows.filter((row) => row.state === NotificationOutboxState.DEAD).length,
    };
  }
}

export function createNotificationOperationsRepository(): NotificationOperationsRepository {
  return env.enableCategoriesJsonFallback && !env.databaseUrl
    ? new JsonNotificationOperationsRepository()
    : new PrismaNotificationOperationsRepository();
}
