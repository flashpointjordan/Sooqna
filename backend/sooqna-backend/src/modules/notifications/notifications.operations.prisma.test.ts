import {
  NotificationBroadcastAudience,
  NotificationBroadcastStatus,
  NotificationOutboxState,
} from "@prisma/client";

const mockTx = {
  $executeRaw: jest.fn(),
  notificationBroadcast: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  notification: {
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  notificationOutbox: {
    findMany: jest.fn(),
    deleteMany: jest.fn(),
    upsert: jest.fn(),
  },
  user: {
    findMany: jest.fn(),
  },
};

const mockPrisma = {
  $transaction: jest.fn(async (operation: (tx: typeof mockTx) => unknown) => operation(mockTx)),
  notificationOutbox: {
    count: jest.fn(),
    findFirst: jest.fn(),
  },
};

jest.mock("../../config/prisma", () => ({ prisma: mockPrisma }));
jest.mock("../../config/env", () => ({ env: { enableCategoriesJsonFallback: false, databaseUrl: "postgresql://test" } }));

import { PrismaNotificationOperationsRepository } from "./notifications.operations";

const now = new Date("2026-09-12T10:00:00.000Z");

describe("Prisma notification operations repository", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTx.$executeRaw.mockResolvedValue(0);
    mockTx.notificationBroadcast.update.mockResolvedValue({});
    mockTx.notificationOutbox.upsert.mockResolvedValue({});
  });

  it("combines a resumed USERS broadcast cursor with its explicit audience", async () => {
    mockTx.notificationBroadcast.findFirst.mockResolvedValue({
      id: "broadcast-1",
      audience: NotificationBroadcastAudience.USERS,
      audienceValue: { userIds: ["user-a", "user-c", "user-z"] },
      title: "Maintenance",
      body: "Brief interruption",
      actionUrl: "/notifications",
      status: NotificationBroadcastStatus.PROCESSING,
      cursor: "user-b",
      deliveredCount: 1,
      createdBy: "admin-1",
      createdAt: now,
      updatedAt: now,
    });
    mockTx.user.findMany.mockResolvedValue([]);

    await new PrismaNotificationOperationsRepository().processBroadcastBatch(25, now);

    expect(mockTx.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        accountStatus: "active",
        AND: [
          { firebaseUid: { gt: "user-b" } },
          { firebaseUid: { in: ["user-a", "user-c", "user-z"] } },
        ],
      },
      take: 26,
    }));
  });

  it("deletes bounded rows using the documented retention windows", async () => {
    mockTx.notification.findMany.mockResolvedValue([{ id: "notification-1" }]);
    mockTx.notificationOutbox.findMany
      .mockResolvedValueOnce([{ id: "processed-1" }])
      .mockResolvedValueOnce([{ id: "dead-1" }]);
    mockTx.notification.deleteMany.mockResolvedValue({ count: 1 });
    mockTx.notificationOutbox.deleteMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(new PrismaNotificationOperationsRepository().cleanupBatch(now, 50)).resolves.toEqual({
      notifications: 1,
      processedOutbox: 1,
      deadOutbox: 1,
      aggregateLedgerKeys: 0,
      hasMore: false,
    });

    expect(mockTx.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
    expect(mockTx.notificationOutbox.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { state: NotificationOutboxState.PROCESSED, processedAt: { lt: new Date("2026-08-29T10:00:00.000Z") } },
      take: 50,
    }));
    expect(mockTx.notificationOutbox.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { state: NotificationOutboxState.DEAD, updatedAt: { lt: new Date("2026-08-13T10:00:00.000Z") } },
      take: 50,
    }));
  });

  it("returns only aggregate queue health fields", async () => {
    mockPrisma.notificationOutbox.count
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2);
    mockPrisma.notificationOutbox.findFirst.mockResolvedValue({ createdAt: new Date(now.getTime() - 8_000) });

    await expect(new PrismaNotificationOperationsRepository().health(now)).resolves.toEqual({
      queueDepth: 4,
      oldestPendingAgeMs: 8_000,
      deadCount: 2,
    });
  });
});
