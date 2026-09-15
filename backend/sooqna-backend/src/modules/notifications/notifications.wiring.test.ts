import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

const mockWorker = { start: jest.fn(), stop: jest.fn(async () => undefined), runOnce: jest.fn(async () => undefined) };
const mockCreateWorker = jest.fn((_deps: unknown) => mockWorker);
const mockOperationsScheduler = { start: jest.fn(), stop: jest.fn(async () => undefined), runOnce: jest.fn(async () => undefined), health: jest.fn(() => ({ state: "idle" })) };
const mockCreateOperationsScheduler = jest.fn(() => mockOperationsScheduler);

jest.mock("../../app", () => ({ app: { listen: jest.fn() } }));
jest.mock("../../config/env", () => ({ env: { port: 3000 } }));
jest.mock("../../config/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("../../config/prisma", () => ({ prisma: { $disconnect: jest.fn(async () => undefined) } }));
jest.mock("./notifications.repository", () => ({ createNotificationsRepository: () => ({}) }));
jest.mock("./notifications.worker", () => ({ createNotificationWorker: mockCreateWorker }));
jest.mock("./notifications.operations", () => ({
  createNotificationOperationsRepository: () => ({}),
  NotificationOperationsService: jest.fn().mockImplementation(() => ({})),
  createNotificationOperationsScheduler: mockCreateOperationsScheduler,
}));

import { getNotificationBroker, getNotificationPublisher } from "./notifications.broker";
import { createNotificationStreamHandler, createProductionNotificationsService } from "./notifications.controller";
import { createServerLifecycle } from "../../server";

function response() {
  const res = new EventEmitter() as Response & { write: jest.Mock; end: jest.Mock; setHeader: jest.Mock; flushHeaders: jest.Mock };
  res.write = jest.fn(() => true);
  res.setHeader = jest.fn();
  res.flushHeaders = jest.fn();
  res.end = jest.fn(() => res);
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

    expect(stream.write).toHaveBeenCalledWith(expect.stringContaining('"event":"notification.changed","notificationId":"notification-1","unreadCount":4,"version":1'));
    expect(getNotificationPublisher()).toBe(workerDependencies.publishSignal);
  });

  test("ends open SSE streams before closing the HTTP server", async () => {
    const order: string[] = [];
    const lifecycle = createServerLifecycle({
      worker: mockWorker as never,
      listen: ((_port: number, ready: () => void) => { ready(); return { close: (done: () => void) => { order.push("server-close"); done(); } } as never; }) as never,
      disconnect: async () => { order.push("disconnect"); },
    });
    lifecycle.start();
    expect(mockOperationsScheduler.start).toHaveBeenCalledTimes(1);
    const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    jest.spyOn(global, "setInterval").mockReturnValue(timer); const clear = jest.spyOn(global, "clearInterval").mockImplementation(() => undefined);
    const req = new EventEmitter() as Request; (req as unknown as { currentUser: unknown }).currentUser = { firebaseUid: "user-a" };
    const stream = response(); await createNotificationStreamHandler(getNotificationBroker())(req, stream);

    await lifecycle.stop();

    expect(stream.end).toHaveBeenCalledTimes(1);
    expect(mockOperationsScheduler.stop).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(getNotificationBroker().activeCount()).toBe(0);
    expect(order).toEqual(["server-close", "disconnect"]);
  });
});
