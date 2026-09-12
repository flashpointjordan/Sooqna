import { NotificationOutboxState, NotificationType } from "@prisma/client";
import { EventEmitter } from "node:events";
import type { Response } from "express";

jest.mock("../../config/env", () => ({
  env: { enableCategoriesJsonFallback: true, databaseUrl: "" },
}));
jest.mock("../../config/prisma", () => ({ prisma: {} }));

import { createNotificationWorker } from "./notifications.worker";
import { NotificationsService } from "./notifications.service";
import { createNotificationPublisher, NotificationBroker } from "./notifications.broker";
import {
  JsonNotificationsRepository,
  type JsonNotificationsStore,
} from "./notifications.json.repository";

const now = new Date("2026-08-24T15:43:00.000Z");

function store(): JsonNotificationsStore & { state: any; notificationState: any } {
  const value = {
    state: {
      conversations: [], messages: [],
      notificationOutbox: [{
        id: "outbox-1", eventType: NotificationType.MESSAGE_RECEIVED,
        aggregateType: "message", aggregateId: "msg-1", recipientId: "recipient-1",
        payload: { eventType: NotificationType.MESSAGE_RECEIVED, recipientId: "recipient-1", conversationId: "conv-1", messageId: "msg-1", senderId: "sender-1", senderName: "Sender", listingId: "listing-1", listingTitle: "Listing", messagePreview: "Hello" },
        dedupeKey: "message:msg-1:recipient-1", state: NotificationOutboxState.PENDING,
        attempts: 0, availableAt: "2026-08-24T15:42:00.000Z", processedAt: null,
        lastError: null, createdAt: "2026-08-24T15:42:00.000Z", updatedAt: "2026-08-24T15:42:00.000Z",
      }],
    },
    notificationState: { notifications: [] as any[], preferences: [] as any[] },
    async mutateMessageState<T>(work: (state: any) => T | Promise<T>) { return work(value.state); },
    async mutateNotificationState<T>(work: (state: any) => T | Promise<T>) {
      return work(value.notificationState);
    },
  };
  return value;
}

describe("JSON notification fallback delivery", () => {
  it("selects the JSON repository for fallback server wiring", async () => {
    const { createNotificationsRepository } = await import("./notifications.repository");
    expect(createNotificationsRepository()).toBeInstanceOf(JsonNotificationsRepository);
  });

  it("claims MESSAGE_RECEIVED, persists the rendered notification, and publishes its SSE signal", async () => {
    const fallbackStore = store();
    const repository = new JsonNotificationsRepository(fallbackStore);
    const broker = new NotificationBroker();
    const stream = new EventEmitter() as Response & { write: jest.Mock; end: jest.Mock };
    stream.write = jest.fn(() => true);
    stream.end = jest.fn();
    broker.subscribe("recipient-1", stream);
    const publishSignal = jest.fn(createNotificationPublisher(broker));
    const service = new NotificationsService(repository, { now: () => now, publishSignal });
    const worker = createNotificationWorker({ repository, service, now: () => now, jitter: () => 0 });

    await worker.runOnce();

    expect(fallbackStore.state.notificationOutbox[0]).toMatchObject({
      state: NotificationOutboxState.PROCESSED,
      attempts: 1,
      processedAt: now.toISOString(),
    });
    expect(fallbackStore.notificationState.notifications).toEqual([
      expect.objectContaining({
        userId: "recipient-1",
        type: NotificationType.MESSAGE_RECEIVED,
        dedupeKey: "message:msg-1:recipient-1",
        entityType: "conversation",
        entityId: "conv-1",
        metadata: expect.objectContaining({ messageId: "msg-1" }),
      }),
    ]);
    expect(publishSignal).toHaveBeenCalledWith("recipient-1", expect.any(String), 1);
    expect(stream.write).toHaveBeenCalledWith(
      expect.stringContaining('"event":"notification.changed"')
    );
  });

  it("does not persist or signal the same fallback event twice", async () => {
    const fallbackStore = store();
    const repository = new JsonNotificationsRepository(fallbackStore);
    const publishSignal = jest.fn();
    const service = new NotificationsService(repository, { now: () => now, publishSignal });
    const worker = createNotificationWorker({ repository, service, now: () => now, jitter: () => 0 });

    await worker.runOnce();
    await worker.runOnce();

    expect(fallbackStore.notificationState.notifications).toHaveLength(1);
    expect(publishSignal).toHaveBeenCalledTimes(1);
  });
});
