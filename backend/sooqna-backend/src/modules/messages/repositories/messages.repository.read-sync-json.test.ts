import type { Conversation, Message } from "../messages.types";

const files = new Map<string, unknown[]>();
let failNotificationWriteOnce = false;

function key(filePath: string): string {
  if (filePath.includes("conversation-read-journal")) return "journal";
  if (filePath.includes("notifications-state.data")) return "notifications";
  if (filePath.includes("messages-state.data")) return "messages";
  if (filePath.includes("conversations.data")) return "legacy-conversations";
  if (filePath.includes("messages.data")) return "legacy-messages";
  return "legacy-outbox";
}

jest.mock("../../../config/env", () => ({
  env: { enableCategoriesJsonFallback: true, databaseUrl: "" },
}));
jest.mock("../../../config/prisma", () => ({ prisma: {} }));
jest.mock("../../../utils/fileStore", () => ({
  readJsonArrayFile: (filePath: string) => structuredClone(files.get(key(filePath)) ?? []),
  writeJsonArrayFileAtomically: (filePath: string, records: unknown[]) => {
    const fileKey = key(filePath);
    if (fileKey === "notifications" && failNotificationWriteOnce) {
      failNotificationWriteOnce = false;
      throw new Error("disk interrupted notification write");
    }
    files.set(fileKey, structuredClone(records));
  },
}));

import { PrismaMessagesRepository } from "./messages.repository";

const now = new Date("2026-09-12T08:00:00.000Z");
const conversation = (id: string, users: string[]): Conversation => ({
  id,
  participantIds: users,
  participants: {},
  listingId: `listing-${id}`,
  listingSnapshot: { title: "Listing", primaryImageURL: "" },
  createdBy: users[0],
  lastMessageText: "",
  lastMessageSenderId: "",
  lastMessageAt: null,
  lastMessageType: "text",
  isActive: true,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
});
const message = (id: string, conversationId: string, senderId: string): Message => ({
  id,
  conversationId,
  senderId,
  clientRequestId: null,
  type: "text",
  text: id,
  attachments: [],
  isRead: false,
  readAt: null,
  createdAt: "2026-09-12T01:00:00.000Z",
  deletedAt: null,
});
const notification = (id: string, userId: string, entityId: string, overrides: Record<string, unknown> = {}) => ({
  id,
  userId,
  type: "MESSAGE_RECEIVED",
  category: "MESSAGES",
  title: "Message",
  body: "Body",
  actionUrl: null,
  entityType: "conversation",
  entityId,
  metadata: {},
  dedupeKey: id,
  aggregationKey: null,
  readAt: null,
  deletedAt: null,
  expiresAt: "2026-10-12T00:00:00.000Z",
  createdAt: "2026-09-12T01:00:00.000Z",
  updatedAt: "2026-09-12T01:00:00.000Z",
  ...overrides,
});

function seed() {
  files.clear();
  failNotificationWriteOnce = false;
  files.set("messages", [{
    conversations: [
      conversation("conv-1", ["reader-1", "sender-1"]),
      conversation("conv-2", ["reader-1", "sender-2"]),
      conversation("conv-private", ["other-1", "other-2"]),
    ],
    messages: [
      message("target-1", "conv-1", "sender-1"),
      message("target-2", "conv-1", "sender-1"),
      message("own", "conv-1", "reader-1"),
      message("other-conversation", "conv-2", "sender-2"),
      message("other-user", "conv-private", "other-2"),
    ],
    notificationOutbox: [],
  }]);
  files.set("notifications", [{
    notifications: [
      notification("target-notification-1", "reader-1", "conv-1"),
      notification("target-notification-2", "reader-1", "conv-1"),
      notification("other-conversation-notification", "reader-1", "conv-2"),
      notification("other-user-notification", "other-1", "conv-1"),
      notification("expired", "reader-1", "conv-1", { expiresAt: "2026-09-01T00:00:00.000Z" }),
    ],
    preferences: [],
    appliedAggregateEventKeys: [],
  }]);
  files.set("journal", []);
}

describe("conversation read reconciliation JSON fallback", () => {
  beforeEach(seed);

  it("updates only the reader and conversation while preserving exact global totals", async () => {
    const result = await new PrismaMessagesRepository().reconcileConversationRead("conv-1", "reader-1", now);

    expect(result).toEqual({
      updatedMessages: 2,
      updatedNotifications: 2,
      messageUnreadTotal: 1,
      notificationUnreadTotal: 1,
    });
    const messageState = (files.get("messages") as any[])[0];
    expect(messageState.messages.filter((row: Message) => row.isRead).map((row: Message) => row.id)).toEqual([
      "target-1",
      "target-2",
    ]);
    const notificationState = (files.get("notifications") as any[])[0];
    expect(notificationState.notifications.filter((row: any) => row.readAt).map((row: any) => row.id)).toEqual([
      "target-notification-1",
      "target-notification-2",
    ]);
    expect(files.get("journal")).toEqual([]);
  });

  it("recovers a split file replacement from its durable roll-forward journal", async () => {
    failNotificationWriteOnce = true;
    const repo = new PrismaMessagesRepository();

    await expect(repo.reconcileConversationRead("conv-1", "reader-1", now)).rejects.toThrow(
      "disk interrupted notification write"
    );
    expect((files.get("journal") as any[])).toHaveLength(1);

    await expect(repo.reconcileConversationRead("conv-1", "reader-1", now)).resolves.toEqual({
      updatedMessages: 0,
      updatedNotifications: 0,
      messageUnreadTotal: 1,
      notificationUnreadTotal: 1,
    });
    expect(files.get("journal")).toEqual([]);
  });

  it("rejects a non-participant inside the shared lock without changing either store", async () => {
    const beforeMessages = structuredClone(files.get("messages"));
    const beforeNotifications = structuredClone(files.get("notifications"));

    await expect(
      new PrismaMessagesRepository().reconcileConversationRead("conv-private", "reader-1", now)
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    expect(files.get("messages")).toEqual(beforeMessages);
    expect(files.get("notifications")).toEqual(beforeNotifications);
    expect(files.get("journal")).toEqual([]);
  });
});
