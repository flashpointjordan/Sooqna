import type { Conversation, Message } from "../messages.types";

const mockFiles = new Map<string, unknown[]>();
const mockRead = jest.fn((filePath: string) => structuredClone(mockFiles.get(filePath) ?? []));
const mockWrite = jest.fn((filePath: string, records: unknown[]) => {
  mockFiles.set(filePath, structuredClone(records));
});
const mockAtomicWrite = jest.fn((filePath: string, records: unknown[]) => {
  mockFiles.set("state", structuredClone(records));
});

jest.mock("../../../config/env", () => ({
  env: { enableCategoriesJsonFallback: true, databaseUrl: "" },
}));
jest.mock("../../../config/prisma", () => ({ prisma: {} }));
jest.mock("../../../utils/fileStore", () => ({
  readJsonArrayFile: (filePath: string) => mockRead(filePath),
  writeJsonArrayFile: (filePath: string, records: unknown[]) => mockWrite(filePath, records),
  writeJsonArrayFileAtomically: (filePath: string, records: unknown[]) => mockAtomicWrite(filePath, records),
}));

import { enqueueNotificationEvent } from "../../notifications/notifications.producer";
import { PrismaMessagesRepository } from "./messages.repository";

const oldConversation: Conversation = {
  id: "conv-1", participantIds: ["sender-1", "recipient-1"],
  participants: { "sender-1": { fullName: "Sender", photoURL: "" }, "recipient-1": { fullName: "Recipient", photoURL: "" } },
  listingId: "listing-1", listingSnapshot: { title: "Listing", primaryImageURL: "" }, createdBy: "sender-1",
  lastMessageText: "", lastMessageSenderId: "", lastMessageAt: null, lastMessageType: "text", isActive: true,
  createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z",
};
const newConversation: Conversation = { ...oldConversation, lastMessageText: "Hello", lastMessageSenderId: "sender-1", lastMessageAt: "2026-08-24T15:42:00.000Z", updatedAt: "2026-08-24T15:42:00.000Z" };
const newMessage: Message = {
  id: "msg-1", conversationId: "conv-1", senderId: "sender-1", clientRequestId: "request-123", type: "text", text: "Hello",
  attachments: [], isRead: false, readAt: null, createdAt: "2026-08-24T15:42:00.000Z", deletedAt: null,
};
const notification = {
  aggregateType: "message", aggregateId: "msg-1", recipientId: "recipient-1", dedupeKey: "message:msg-1:recipient-1",
  payload: { eventType: "MESSAGE_RECEIVED" as const, recipientId: "recipient-1", conversationId: "conv-1", messageId: "msg-1", senderId: "sender-1", senderName: "Sender", listingId: "listing-1", messagePreview: "Hello" },
};

function seedFiles() {
  mockFiles.clear();
  mockFiles.set("messages", []);
  mockFiles.set("conversations", [oldConversation]);
  mockFiles.set("notification-outbox", []);
  mockRead.mockImplementation((filePath: string) => {
    const key = filePath.includes("messages-state.data") ? "state" : filePath.includes("messages.data") ? "messages" : filePath.includes("conversations.data") ? "conversations" : "notification-outbox";
    return structuredClone(mockFiles.get(key) ?? []);
  });
  mockWrite.mockImplementation((filePath: string, records: unknown[]) => {
    const key = filePath.includes("messages.data") ? "messages" : filePath.includes("conversations.data") ? "conversations" : "notification-outbox";
    mockFiles.set(key, structuredClone(records));
  });
  mockAtomicWrite.mockImplementation((_filePath: string, records: unknown[]) => {
    mockFiles.set("state", structuredClone(records));
  });
}

describe("message JSON fallback atomicity", () => {
  beforeEach(seedFiles);

  it("stages a durable outbox event and commits all three snapshots", async () => {
    const result = await new PrismaMessagesRepository().createMessageAtomically(
      { message: newMessage, conversation: newConversation, notifications: [notification] },
      enqueueNotificationEvent
    );
    expect(result.created).toBe(true);
    const state = (mockFiles.get("state") as any[])[0];
    expect(mockAtomicWrite).toHaveBeenCalledTimes(1);
    expect(state.messages).toHaveLength(1);
    expect(state.conversations).toEqual([newConversation]);
    expect(state.notificationOutbox).toEqual([
      expect.objectContaining({ dedupeKey: "message:msg-1:recipient-1", aggregateId: "msg-1" }),
    ]);
  });

  it("leaves every legacy snapshot unchanged when the atomic state replacement fails", async () => {
    mockAtomicWrite.mockImplementation(() => { throw new Error("disk full"); });

    await expect(new PrismaMessagesRepository().createMessageAtomically(
      { message: newMessage, conversation: newConversation, notifications: [notification] },
      enqueueNotificationEvent
    )).rejects.toThrow("disk full");

    expect(mockFiles.get("messages")).toEqual([]);
    expect(mockFiles.get("conversations")).toEqual([oldConversation]);
    expect(mockFiles.get("notification-outbox")).toEqual([]);
    expect(mockFiles.has("state")).toBe(false);
  });

  it("maps legacy JSON messages without a request id to null", async () => {
    mockFiles.set("messages", [{ ...newMessage, clientRequestId: undefined }]);
    const messages = await new PrismaMessagesRepository().listMessages("conv-1");
    expect(messages).toEqual([expect.objectContaining({ id: "msg-1", clientRequestId: null })]);
  });

  it("keeps the first serialized conversation preview when distinct messages share a timestamp", async () => {
    const repository = new PrismaMessagesRepository();
    const secondMessage = { ...newMessage, id: "msg-2", clientRequestId: "request-456", text: "Second" };
    await repository.createMessageAtomically(
      { message: newMessage, conversation: newConversation, notifications: [] },
      enqueueNotificationEvent
    );
    await repository.createMessageAtomically(
      { message: secondMessage, conversation: { ...newConversation, lastMessageText: "Second" }, notifications: [] },
      enqueueNotificationEvent
    );

    const state = (mockFiles.get("state") as any[])[0];
    expect(state.messages).toHaveLength(2);
    expect(state.conversations[0].lastMessageText).toBe("Hello");
  });
});
