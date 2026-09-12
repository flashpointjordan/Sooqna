const mockReadJson = jest.fn((_filePath: string): unknown[] => []);
const mockWriteJson = jest.fn((_filePath: string, _rows: unknown[]): void => undefined);

jest.mock("../../../config/env", () => ({
  env: {
    enableCategoriesJsonFallback: true,
    databaseUrl: "postgresql://configured-but-unreachable",
    nodeEnv: "development",
  },
}));
jest.mock("../../../config/prisma", () => ({ prisma: {} }));
jest.mock("../../../utils/fileStore", () => ({
  readJsonArrayFile: (filePath: string) => mockReadJson(filePath),
  writeJsonArrayFileAtomically: (filePath: string, rows: unknown[]) =>
    mockWriteJson(filePath, rows),
}));

import type { TransactionRunner } from "../../../shared/database/unitOfWork";
import { PrismaMessagesRepository } from "./messages.repository";
import {
  createNotificationsRepository,
  PrismaNotificationsRepository,
} from "../../notifications/notifications.repository";

describe("configured database persistence mode", () => {
  it("rejects a runtime database failure without silently switching the message to JSON", async () => {
    const databaseFailure = new Error("database unavailable");
    const transactions: TransactionRunner = {
      run: jest.fn().mockRejectedValue(databaseFailure),
    };
    const repository = new PrismaMessagesRepository(transactions);

    await expect(repository.createMessageAtomically({
      message: {
        id: "msg-1", conversationId: "conv-1", senderId: "sender-1",
        clientRequestId: "request-123", type: "text", text: "Hello", attachments: [],
        isRead: false, readAt: null, createdAt: "2026-08-24T15:42:00.000Z", deletedAt: null,
      },
      conversation: {
        id: "conv-1", participantIds: ["sender-1", "recipient-1"],
        participants: { "sender-1": { fullName: "Sender", photoURL: "" }, "recipient-1": { fullName: "Recipient", photoURL: "" } },
        listingId: "listing-1", listingSnapshot: { title: "Listing", primaryImageURL: "" },
        createdBy: "sender-1", lastMessageText: "Hello", lastMessageSenderId: "sender-1",
        lastMessageAt: "2026-08-24T15:42:00.000Z", lastMessageType: "text", isActive: true,
        createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T15:42:00.000Z",
      },
      notifications: [],
    }, jest.fn())).rejects.toBe(databaseFailure);

    expect(mockReadJson).not.toHaveBeenCalled();
    expect(mockWriteJson).not.toHaveBeenCalled();
    expect(createNotificationsRepository()).toBeInstanceOf(PrismaNotificationsRepository);
  });
});
