import { NotificationBroadcastAudience, NotificationBroadcastStatus, NotificationType, Role } from "@prisma/client";
const mockCleanupMessageState = { notificationOutbox: [] as Array<Record<string, unknown>> };
const mockCleanupNotificationState = { notifications: [] as Array<Record<string, unknown>>, appliedAggregateEventKeys: [] as string[] };
const mockJsonLock = jest.fn(async <T>(operation: () => T | Promise<T>) => operation());
const mockCommitJsonState = jest.fn();
jest.mock("../../config/prisma", () => ({ prisma: {} }));
jest.mock("../../config/env", () => ({ env: { enableCategoriesJsonFallback: true, databaseUrl: "" } }));
jest.mock("../../shared/database/marketplaceJsonLock", () => ({ withMarketplaceJsonLock: (operation: () => unknown) => mockJsonLock(operation) }));
jest.mock("../messages/repositories/messages.repository", () => ({ readJsonMessageFallbackStateUnlocked: () => mockCleanupMessageState }));
jest.mock("../messages/repositories/conversationReadJsonCoordinator", () => ({
  readJsonNotificationStateUnlocked: () => mockCleanupNotificationState,
  commitJsonConversationReadUnlocked: (...args: unknown[]) => mockCommitJsonState(...args),
}));
import {
  createNotificationOperationsScheduler,
  cleanupJsonNotificationState,
  JsonNotificationOperationsRepository,
  NotificationOperationsService,
  type NotificationBroadcastInput,
  type NotificationOperationsRepository,
  type StoredNotificationBroadcast,
} from "./notifications.operations";

const now = new Date("2026-09-12T10:00:00.000Z");

class MemoryOperationsRepository implements NotificationOperationsRepository {
  broadcasts: StoredNotificationBroadcast[] = [];
  outbox: Array<{ dedupeKey: string; recipientId: string; payload: Record<string, unknown> }> = [];
  users = [
    { firebaseUid: "a", role: Role.BUYER, accountStatus: "active" },
    { firebaseUid: "b", role: Role.SELLER, accountStatus: "active" },
    { firebaseUid: "z", role: Role.ADMIN, accountStatus: "suspended" },
  ];
  cleanupCalls = 0;

  async createBroadcast(input: NotificationBroadcastInput, createdAt: Date) {
    const row: StoredNotificationBroadcast = {
      id: `broadcast-${this.broadcasts.length + 1}`,
      ...input,
      status: NotificationBroadcastStatus.PENDING,
      cursor: null,
      deliveredCount: 0,
      createdAt,
      updatedAt: createdAt,
    };
    this.broadcasts.push(row);
    return row;
  }

  async processBroadcastBatch(limit: number, processedAt: Date) {
    const broadcast = this.broadcasts.find((row) => row.status !== NotificationBroadcastStatus.COMPLETED);
    if (!broadcast) return { broadcastId: null, enqueued: 0, completed: true };
    broadcast.status = NotificationBroadcastStatus.PROCESSING;
    const allowed = this.users.filter((user) => {
      if (user.accountStatus !== "active") return false;
      if (broadcast.audience === NotificationBroadcastAudience.ROLES) return (broadcast.audienceValue?.roles ?? []).includes(user.role);
      if (broadcast.audience === NotificationBroadcastAudience.USERS) return (broadcast.audienceValue?.userIds ?? []).includes(user.firebaseUid);
      return true;
    }).filter((user) => !broadcast.cursor || user.firebaseUid > broadcast.cursor).slice(0, limit);
    for (const user of allowed) {
      const dedupeKey = `broadcast:${broadcast.id}:${user.firebaseUid}`;
      if (!this.outbox.some((row) => row.dedupeKey === dedupeKey)) this.outbox.push({
        dedupeKey,
        recipientId: user.firebaseUid,
        payload: { eventType: NotificationType.SYSTEM_ANNOUNCEMENT, recipientId: user.firebaseUid, announcementId: broadcast.id, title: broadcast.title, body: broadcast.body, actionUrl: broadcast.actionUrl },
      });
    }
    broadcast.deliveredCount += allowed.length;
    broadcast.cursor = allowed.at(-1)?.firebaseUid ?? broadcast.cursor;
    const remaining = this.users.some((user) => user.accountStatus === "active" && (!broadcast.cursor || user.firebaseUid > broadcast.cursor) && (broadcast.audience !== NotificationBroadcastAudience.USERS || (broadcast.audienceValue?.userIds ?? []).includes(user.firebaseUid)) && (broadcast.audience !== NotificationBroadcastAudience.ROLES || (broadcast.audienceValue?.roles ?? []).includes(user.role)));
    if (!remaining) broadcast.status = NotificationBroadcastStatus.COMPLETED;
    broadcast.updatedAt = processedAt;
    return { broadcastId: broadcast.id, enqueued: allowed.length, completed: !remaining };
  }

  async cleanupBatch() {
    this.cleanupCalls += 1;
    return { notifications: 2, processedOutbox: 3, deadOutbox: 4, aggregateLedgerKeys: 1, hasMore: false };
  }

  async health(at: Date) {
    return { queueDepth: 2, oldestPendingAgeMs: at.getTime() - now.getTime(), deadCount: 1 };
  }
}

describe("notification operational service", () => {
  beforeEach(() => {
    mockCleanupMessageState.notificationOutbox = [];
    mockCleanupNotificationState.notifications = [];
    mockCleanupNotificationState.appliedAggregateEventKeys = [];
    mockJsonLock.mockClear();
    mockCommitJsonState.mockClear();
  });

  it("persists and resumes bounded ADMIN broadcasts with deterministic recipient events", async () => {
    const repo = new MemoryOperationsRepository();
    const audit = jest.fn(async () => undefined);
    const service = new NotificationOperationsService(repo, { now: () => now, audit });
    const row = await service.createBroadcast("admin-1", {
      audience: "ALL",
      audienceValue: null,
      title: "Maintenance",
      body: "The marketplace will be unavailable briefly.",
      actionUrl: "/notifications",
    });

    await service.processBroadcastBatch(1);
    await service.processBroadcastBatch(1);
    await service.processBroadcastBatch(1);

    expect(row.status).toBe(NotificationBroadcastStatus.COMPLETED);
    expect(repo.outbox.map((event) => event.dedupeKey)).toEqual([
      `broadcast:${row.id}:a`,
      `broadcast:${row.id}:b`,
    ]);
    expect(repo.outbox.every((event) => event.payload.eventType === "SYSTEM_ANNOUNCEMENT")).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "admin.notification.broadcast",
      actorId: "admin-1",
      targetId: row.id,
      metadata: { audience: "ALL" },
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("unavailable briefly");
  });

  it("runs cleanup once per UTC day, continues broadcast batches, and stops cleanly", async () => {
    const repo = new MemoryOperationsRepository();
    const clock = { value: now };
    const service = new NotificationOperationsService(repo, { now: () => clock.value });
    const scheduler = createNotificationOperationsScheduler({ service, intervalMs: 100, now: () => clock.value });

    await scheduler.runOnce();
    await scheduler.runOnce();
    clock.value = new Date("2026-09-13T00:00:00.000Z");
    await scheduler.runOnce();
    await scheduler.stop();
    await scheduler.runOnce();

    expect(repo.cleanupCalls).toBe(2);
    expect(scheduler.health().state).toBe("stopped");
  });

  it("returns aggregate privacy-safe operational health only", async () => {
    const repo = new MemoryOperationsRepository();
    const service = new NotificationOperationsService(repo, { now: () => new Date(now.getTime() + 5_000) });
    expect(await service.health({ workerState: "stopped", operationsSchedulerState: "running", activeStreams: 7 })).toEqual({
      queueDepth: 2,
      oldestPendingAgeMs: 5_000,
      deadCount: 1,
      workerState: "stopped",
      operationsSchedulerState: "running",
      activeStreams: 7,
    });
  });

  it("cleans JSON fallback rows by retention window and prunes matching aggregate ledger keys", () => {
    const notificationState = {
      notifications: [
        { id: "expired", expiresAt: "2026-09-12T09:59:59.000Z", deletedAt: null },
        { id: "deleted", expiresAt: "2026-10-12T00:00:00.000Z", deletedAt: "2026-09-11T00:00:00.000Z" },
        { id: "active", expiresAt: "2026-10-12T00:00:00.000Z", deletedAt: null },
      ],
      preferences: [],
      appliedAggregateEventKeys: ["processed-old", "dead-old", "still-live"],
    };
    const messageState = {
      conversations: [], messages: [], notificationOutbox: [
        { id: "processed-old", dedupeKey: "processed-old", state: "PROCESSED", processedAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z" },
        { id: "dead-old", dedupeKey: "dead-old", state: "DEAD", processedAt: null, updatedAt: "2026-08-01T00:00:00.000Z" },
        { id: "still-live", dedupeKey: "still-live", state: "PROCESSED", processedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
      ],
    };

    expect(cleanupJsonNotificationState(messageState as never, notificationState as never, now, 10)).toEqual({
      notifications: 2,
      processedOutbox: 1,
      deadOutbox: 1,
      aggregateLedgerKeys: 2,
      hasMore: false,
    });
    expect(notificationState.notifications.map((row) => row.id)).toEqual(["active"]);
    expect(messageState.notificationOutbox.map((row) => row.id)).toEqual(["still-live"]);
    expect(notificationState.appliedAggregateEventKeys).toEqual(["still-live"]);
  });

  it("runs JSON repository cleanup as bounded, locked batches and persists both state files", async () => {
    mockCleanupNotificationState.notifications = [
      { id: "expired-1", expiresAt: "2026-09-12T09:00:00.000Z", deletedAt: null },
      { id: "expired-2", expiresAt: "2026-09-12T09:00:00.000Z", deletedAt: null },
      { id: "active", expiresAt: "2026-10-12T09:00:00.000Z", deletedAt: null },
    ];
    mockCleanupNotificationState.appliedAggregateEventKeys = ["processed-1", "processed-2", "still-live"];
    mockCleanupMessageState.notificationOutbox = [
      { id: "processed-1", dedupeKey: "processed-1", state: "PROCESSED", processedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
      { id: "processed-2", dedupeKey: "processed-2", state: "PROCESSED", processedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
      { id: "still-live", dedupeKey: "still-live", state: "PROCESSED", processedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
    ];
    const repository = new JsonNotificationOperationsRepository();

    const firstBatch = await repository.cleanupBatch(now, 1);
    expect(firstBatch).toEqual({ notifications: 1, processedOutbox: 1, deadOutbox: 0, aggregateLedgerKeys: 1, hasMore: true });
    expect(mockJsonLock).toHaveBeenCalledTimes(1);
    expect(mockCommitJsonState).toHaveBeenCalledTimes(1);
    expect(mockCommitJsonState).toHaveBeenCalledWith(mockCleanupMessageState, mockCleanupNotificationState);
    expect(mockCleanupNotificationState.notifications).toHaveLength(2);
    expect(mockCleanupMessageState.notificationOutbox).toHaveLength(2);
    expect(mockCleanupNotificationState.appliedAggregateEventKeys).toEqual(["processed-2", "still-live"]);

    const secondBatch = await repository.cleanupBatch(now, 1);
    expect(secondBatch).toEqual({ notifications: 1, processedOutbox: 1, deadOutbox: 0, aggregateLedgerKeys: 1, hasMore: true });
    expect(mockCommitJsonState).toHaveBeenCalledTimes(2);
    expect(mockCleanupNotificationState.appliedAggregateEventKeys).toEqual(["still-live"]);
    expect(mockCleanupMessageState.notificationOutbox).toHaveLength(1);

    const finalBatch = await repository.cleanupBatch(now, 1);
    expect(finalBatch.hasMore).toBe(false);
    expect(mockCleanupNotificationState.notifications).toHaveLength(1);
    expect(mockCleanupMessageState.notificationOutbox).toHaveLength(1);
  });
});
