import { EventEmitter } from "node:events";
import type { Response } from "express";

const mockWorker = { start: jest.fn(), stop: jest.fn(async () => undefined), runOnce: jest.fn(async () => undefined) };
const mockCreateWorker = jest.fn((_deps: unknown) => mockWorker);

jest.mock("../../app", () => ({ app: { listen: jest.fn() } }));
jest.mock("../../config/env", () => ({ env: { port: 3000 } }));
jest.mock("../../config/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("../../config/prisma", () => ({ prisma: { $disconnect: jest.fn(async () => undefined) } }));
jest.mock("./notifications.repository", () => ({ PrismaNotificationsRepository: class {} }));
jest.mock("./notifications.worker", () => ({ createNotificationWorker: mockCreateWorker }));

import { getNotificationBroker, getNotificationPublisher } from "./notifications.broker";
import { createProductionNotificationsService } from "./notifications.controller";
import { createServerLifecycle } from "../../server";

function response() {
  const res = new EventEmitter() as Response & { write: jest.Mock };
  res.write = jest.fn(() => true);
  return res;
}

describe("notification production wiring", () => {
  test("uses the server-created broker publisher for both worker and REST signals", async () => {
    createServerLifecycle({ disconnect: async () => undefined });
    const workerDependencies = mockCreateWorker.mock.calls[0][0] as { publishSignal: unknown };
    expect(workerDependencies.publishSignal).toBe(getNotificationPublisher());

    const stream = response(); getNotificationBroker().subscribe("user-a", stream);
    const row = { id: "notification-1", userId: "user-a", type: "LISTING_APPROVED", category: "LISTINGS", title: "title", body: "body", actionUrl: null, entityType: null, entityId: null, metadata: {}, dedupeKey: null, aggregationKey: null, readAt: null, deletedAt: null, expiresAt: new Date(), createdAt: new Date(), updatedAt: new Date() };
    const restService = createProductionNotificationsService({ markReadOwned: async () => ({ row, changed: true }), countUnread: async () => 4 } as never);
    await restService.markRead("user-a", "notification-1");

    expect(stream.write).toHaveBeenCalledWith(expect.stringContaining('"id":"notification-1","unreadCount":4,"version":1'));
    expect(getNotificationPublisher()).toBe(workerDependencies.publishSignal);
  });
});
