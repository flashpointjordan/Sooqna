import type { TransactionContext, TransactionRunner } from "../../../shared/database/unitOfWork";
import { PrismaMessagesRepository } from "./messages.repository";
import { prisma } from "../../../config/prisma";

jest.mock("../../../config/env", () => ({
  env: { enableCategoriesJsonFallback: false, databaseUrl: "postgresql://test" },
}));
jest.mock("../../../config/prisma", () => ({
  prisma: { message: { groupBy: jest.fn() } },
}));

const mockMessageGroupBy = prisma.message.groupBy as jest.Mock;

const now = new Date("2026-09-12T08:00:00.000Z");

function setup() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([{ id: "participant-1" }]),
    message: {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      count: jest.fn().mockResolvedValue(0),
    },
    notification: {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      count: jest.fn().mockResolvedValue(0),
    },
  } as unknown as TransactionContext;
  const run = jest.fn(async (work: (context: TransactionContext) => Promise<unknown>) => work(tx));
  return {
    repo: new PrismaMessagesRepository({ run } as TransactionRunner),
    tx: tx as any,
    run,
  };
}

describe("conversation read-state reconciliation", () => {
  it("marks exactly the reader's cross-model rows and returns exact post-commit counts", async () => {
    const { repo, tx, run } = setup();

    await expect(repo.reconcileConversationRead("conv-1", "reader-1", now)).resolves.toEqual({
      updatedMessages: 2,
      updatedNotifications: 2,
      messageUnreadTotal: 0,
      notificationUnreadTotal: 0,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.calls[0][0].values).toEqual(["conversation:conv-1"]);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[0]
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.message.updateMany.mock.invocationCallOrder[0]
    );
    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: {
        conversationId: "conv-1",
        senderId: { not: "reader-1" },
        isRead: false,
        deletedAt: null,
        conversation: { participants: { some: { userId: "reader-1" } } },
      },
      data: { isRead: true, readAt: now },
    });
    expect(tx.notification.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "reader-1",
        type: "MESSAGE_RECEIVED",
        entityType: "conversation",
        entityId: "conv-1",
        readAt: null,
        deletedAt: null,
        expiresAt: { gt: now },
      },
      data: { readAt: now },
    });
    expect(tx.message.count).toHaveBeenCalledWith({
      where: {
        senderId: { not: "reader-1" },
        isRead: false,
        deletedAt: null,
        conversation: { participants: { some: { userId: "reader-1" } } },
      },
    });
    expect(tx.notification.count).toHaveBeenCalledWith({
      where: {
        userId: "reader-1",
        readAt: null,
        deletedAt: null,
        expiresAt: { gt: now },
      },
    });
  });

  it("rejects inside the transaction when concurrent membership is no longer present", async () => {
    const { repo, tx } = setup();
    tx.$queryRaw.mockResolvedValueOnce([]);

    await expect(repo.reconcileConversationRead("conv-1", "reader-1", now)).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
    });

    expect(tx.message.updateMany).not.toHaveBeenCalled();
    expect(tx.notification.updateMany).not.toHaveBeenCalled();
    expect(tx.message.count).not.toHaveBeenCalled();
    expect(tx.notification.count).not.toHaveBeenCalled();
  });

  it("aggregates unread rows in PostgreSQL while retaining participant ownership", async () => {
    const { repo } = setup();
    mockMessageGroupBy.mockResolvedValueOnce([
      { conversationId: "conv-1", _count: { _all: 2 } },
      { conversationId: "conv-2", _count: { _all: 1 } },
    ]);

    await expect(repo.getUnreadCountMapForUser("reader-1")).resolves.toEqual({
      "conv-1": 2,
      "conv-2": 1,
    });

    expect(mockMessageGroupBy).toHaveBeenCalledWith({
      by: ["conversationId"],
      where: {
        senderId: { not: "reader-1" },
        isRead: false,
        deletedAt: null,
        conversation: { participants: { some: { userId: "reader-1" } } },
      },
      _count: { _all: true },
    });
  });
});
