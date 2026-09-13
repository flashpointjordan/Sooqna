import type { TransactionContext, TransactionRunner } from "../../../shared/database/unitOfWork";
import type { Conversation, Message } from "../messages.types";
import { PrismaMessagesRepository } from "./messages.repository";

jest.mock("../../../config/env", () => ({
  env: { enableCategoriesJsonFallback: false, databaseUrl: "postgresql://test" },
}));
jest.mock("../../../config/prisma", () => ({ prisma: {} }));

const createdAt = new Date("2026-08-24T15:42:00.000Z");

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    senderId: "sender-1",
    clientRequestId: "request-123",
    type: "text",
    text: "Hello",
    attachments: [],
    isRead: false,
    readAt: null,
    createdAt: createdAt.toISOString(),
    deletedAt: null,
    ...overrides,
  };
}

function conversation(): Conversation {
  return {
    id: "conv-1",
    participantIds: ["sender-1", "recipient-1"],
    participants: {
      "sender-1": { fullName: "Sender", photoURL: "" },
      "recipient-1": { fullName: "Recipient", photoURL: "" },
    },
    listingId: "listing-1",
    listingSnapshot: { title: "Listing", primaryImageURL: "" },
    createdBy: "sender-1",
    lastMessageText: "Hello",
    lastMessageSenderId: "sender-1",
    lastMessageAt: createdAt.toISOString(),
    lastMessageType: "text",
    isActive: true,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
  };
}

function prismaRow(value: Message) {
  return {
    ...value,
    attachments: value.attachments,
    createdAt: new Date(value.createdAt),
    readAt: null,
    deletedAt: null,
  };
}

function setup(existing: Message | null = null) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    message: {
      findUnique: jest.fn().mockResolvedValue(existing ? prismaRow(existing) : null),
      create: jest.fn().mockImplementation(async ({ data }) => ({ ...data, createdAt, readAt: null, deletedAt: null })),
    },
    conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  } as unknown as TransactionContext;
  const run = jest.fn(async (work: (context: TransactionContext) => Promise<unknown>) => work(tx));
  const repo = new PrismaMessagesRepository({ run } as TransactionRunner);
  return { repo, tx: tx as any, run };
}

describe("PrismaMessagesRepository atomic message creation", () => {
  it("uses one transaction for lookup, insert, conversation update, and exact recipient events", async () => {
    const { repo, tx, run } = setup();
    const enqueue = jest.fn().mockResolvedValue({});
    const notification = {
      aggregateType: "message",
      aggregateId: "msg-1",
      recipientId: "recipient-1",
      dedupeKey: "message:msg-1:recipient-1",
      payload: {
        eventType: "MESSAGE_RECEIVED" as const,
        recipientId: "recipient-1",
        conversationId: "conv-1",
        messageId: "msg-1",
        senderId: "sender-1",
        senderName: "Sender",
        listingId: "listing-1",
        listingTitle: "Listing",
        messagePreview: "Hello",
      },
    };

    const result = await repo.createMessageAtomically(
      { message: message(), conversation: conversation(), notifications: [notification] },
      enqueue
    );

    expect(result).toMatchObject({ created: true, message: { id: "msg-1", clientRequestId: "request-123" } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw.mock.calls[0][0].values).toEqual(["conversation:conv-1"]);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.message.findUnique.mock.invocationCallOrder[0]
    );
    expect(tx.message.create).toHaveBeenCalledTimes(1);
    expect(tx.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "conv-1" }),
      data: expect.objectContaining({ lastMessageText: "Hello", lastMessageSenderId: "sender-1" }),
    }));
    expect(enqueue).toHaveBeenCalledWith(notification, tx);
  });

  it("returns an identical replay without inserting, updating, or enqueuing", async () => {
    const persisted = message({ id: "persisted-message" });
    const { repo, tx } = setup(persisted);
    const enqueue = jest.fn();

    const result = await repo.createMessageAtomically(
      { message: message({ id: "new-generated-id" }), conversation: conversation(), notifications: [] },
      enqueue
    );

    expect(result).toEqual({ message: persisted, created: false });
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.conversation.updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("scopes the idempotency lookup by conversation, sender, and request id", async () => {
    const { repo, tx } = setup();
    await repo.createMessageAtomically(
      { message: message({ conversationId: "conv-2", senderId: "sender-2" }), conversation: { ...conversation(), id: "conv-2" }, notifications: [] },
      jest.fn()
    );
    expect(tx.message.findUnique).toHaveBeenCalledWith({
      where: {
        conversationId_senderId_clientRequestId: {
          conversationId: "conv-2",
          senderId: "sender-2",
          clientRequestId: "request-123",
        },
      },
    });
  });

  it("rejects from the transaction when enqueue fails", async () => {
    const { repo } = setup();
    await expect(
      repo.createMessageAtomically(
        { message: message(), conversation: conversation(), notifications: [{
          aggregateType: "message", aggregateId: "msg-1", recipientId: "recipient-1", dedupeKey: "message:msg-1:recipient-1",
          payload: { eventType: "MESSAGE_RECEIVED", recipientId: "recipient-1", conversationId: "conv-1", messageId: "msg-1", senderId: "sender-1", senderName: "Sender", listingId: "listing-1", messagePreview: "Hello" },
        }] },
        jest.fn().mockRejectedValue(new Error("outbox unavailable"))
      )
    ).rejects.toThrow("outbox unavailable");
  });
});
