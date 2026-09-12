import type { MessagesRepository } from "./repositories/messages.repository";
import { MessagesService } from "./messages.service";

function repository(): jest.Mocked<MessagesRepository> {
  return {
    createConversation: jest.fn(),
    findConversationById: jest.fn().mockResolvedValue({
      id: "conv-1",
      participantIds: ["reader-1", "sender-1"],
      participants: {},
      listingId: "listing-1",
      listingSnapshot: { title: "Listing", primaryImageURL: "" },
      createdBy: "reader-1",
      lastMessageText: "",
      lastMessageSenderId: "",
      lastMessageAt: null,
      lastMessageType: "text",
      isActive: true,
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    }),
    listConversationsForUser: jest.fn(),
    updateConversation: jest.fn(),
    createMessage: jest.fn(),
    createMessageAtomically: jest.fn(),
    listMessages: jest.fn(),
    reconcileConversationRead: jest.fn().mockResolvedValue({
      updatedMessages: 2,
      updatedNotifications: 2,
      messageUnreadTotal: 0,
      notificationUnreadTotal: 0,
    }),
    getUnreadCountMapForUser: jest.fn(),
  };
}

describe("MessagesService conversation read reconciliation", () => {
  it("publishes one content-free signal only after the atomic repository operation commits", async () => {
    const repo = repository();
    const order: string[] = [];
    repo.reconcileConversationRead.mockImplementation(async () => {
      order.push("commit");
      return {
        updatedMessages: 2,
        updatedNotifications: 2,
        messageUnreadTotal: 0,
        notificationUnreadTotal: 0,
      };
    });
    const publish = jest.fn(async (userId: string, notificationId: string, unreadCount: number) => {
      order.push("publish");
      expect(userId).toBe("reader-1");
      expect(notificationId).toBe("");
      expect(unreadCount).toBe(0);
    });
    const service = new MessagesService(repo, undefined, publish, () => new Date("2026-09-12T08:00:00.000Z"));

    await expect(service.markConversationRead("conv-1", "reader-1")).resolves.toEqual({
      updatedMessages: 2,
      updatedNotifications: 2,
      messageUnreadTotal: 0,
      notificationUnreadTotal: 0,
    });
    expect(order).toEqual(["commit", "publish"]);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not publish when ownership validation fails", async () => {
    const repo = repository();
    repo.findConversationById.mockResolvedValueOnce({
      ...(await repo.findConversationById("conv-1"))!,
      participantIds: ["someone-else"],
    });
    const publish = jest.fn();
    const service = new MessagesService(repo, undefined, publish);

    await expect(service.markConversationRead("conv-1", "reader-1")).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(repo.reconcileConversationRead).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not publish when the atomic reconciliation rolls back", async () => {
    const repo = repository();
    repo.reconcileConversationRead.mockRejectedValueOnce(new Error("transaction rolled back"));
    const publish = jest.fn();
    const service = new MessagesService(repo, undefined, publish);

    await expect(service.markConversationRead("conv-1", "reader-1")).rejects.toThrow(
      "transaction rolled back"
    );
    expect(publish).not.toHaveBeenCalled();
  });
});
