import { EventEmitter } from "node:events";
import express, { type Request, type Response } from "express";
import request from "supertest";
jest.mock("express-rate-limit", () => ({ __esModule: true, default: jest.fn((options) => {
  const middleware = (_req: Request, _res: Response, next: () => void) => next();
  return Object.assign(middleware, { options });
}) }));
jest.mock("../../routes", () => {
  const express = require("express");
  return { apiRouter: express.Router() };
});
jest.mock("./notifications.repository", () => ({ PrismaNotificationsRepository: class {} }));
const mockAuth = { bearer: true, current: true, active: true, verified: true, uid: "user-a" };
jest.mock("../../middleware/verifyFirebaseToken", () => ({ verifyFirebaseToken: (req: Request, res: Response, next: () => void): void => {
  if (!mockAuth.bearer) { res.status(401).json({ code: "UNAUTHORIZED" }); return; }
  (req as unknown as { authUser: unknown }).authUser = { uid: mockAuth.uid }; next();
} }));
jest.mock("../../middleware/authContext", () => ({
  requireCurrentUser: (req: Request, res: Response, next: () => void): void => {
    if (!mockAuth.current) { res.status(401).json({ code: "UNAUTHORIZED" }); return; }
    (req as unknown as { currentUser: unknown }).currentUser = { firebaseUid: mockAuth.uid }; next();
  },
  requireActiveUser: (_req: Request, res: Response, next: () => void): void => {
    if (!mockAuth.active) { res.status(403).json({ code: "ACCOUNT_INACTIVE" }); return; }
    next();
  },
}));
jest.mock("../../middleware/requireVerifiedEmail", () => ({ requireVerifiedEmail: (_req: Request, res: Response, next: () => void): void => {
  if (!mockAuth.verified) { res.status(403).json({ code: "EMAIL_NOT_VERIFIED" }); return; }
  next();
} }));
import { createNotificationPublisher, NotificationBroker, setNotificationPublisher } from "./notifications.broker";
import { createNotificationStreamHandler, createProductionNotificationsService } from "./notifications.controller";
import { createNotificationsRouter } from "./notifications.routes";

function streamRequest(userId = "user-a") {
  const req = new EventEmitter() as Request;
  Object.assign(req, { currentUser: { firebaseUid: userId } });
  return req;
}

function streamResponse() {
  const res = new EventEmitter() as Response & { headers: Record<string, string>; writes: string[]; flushHeaders: jest.Mock; write: jest.Mock };
  Object.assign(res, {
    headers: {}, writes: [],
    setHeader(name: string, value: string) { res.headers[name] = value; },
    flushHeaders: jest.fn(),
    write: jest.fn((value: string) => { res.writes.push(value); return true; }),
  });
  return res;
}

describe("notification stream", () => {
  afterEach(() => { jest.restoreAllMocks(); Object.assign(mockAuth, { bearer: true, current: true, active: true, verified: true, uid: "user-a" }); });

  test("sets SSE headers, sends retry and unref'd heartbeat without an initial body", async () => {
    const broker = new NotificationBroker(); const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    const interval = jest.spyOn(global, "setInterval").mockReturnValue(timer);
    const handler = createNotificationStreamHandler(broker); const req = streamRequest(); const res = streamResponse();

    await handler(req, res);

    expect(res.headers).toEqual({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
    expect(res.writes).toEqual(["retry: 5000\n\n"]);
    expect(timer.unref).toHaveBeenCalledTimes(1);
    const heartbeat = interval.mock.calls[0][0] as () => void; heartbeat();
    expect(res.writes).toEqual(["retry: 5000\n\n", ": heartbeat\n\n"]);
    req.emit("aborted");
  });

  test("derives stream ownership from currentUser and cleans up once on abort or close", async () => {
    const broker = new NotificationBroker(); const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    jest.spyOn(global, "setInterval").mockReturnValue(timer); const clear = jest.spyOn(global, "clearInterval").mockImplementation(() => undefined);
    const req = streamRequest("user-a"); const res = streamResponse();
    await createNotificationStreamHandler(broker)(req, res);
    broker.publish("user-b", { event: "notification", id: "other", unreadCount: 1, version: 1 });
    expect(res.writes).toEqual(["retry: 5000\n\n"]);
    req.emit("aborted");
    expect(broker.activeCount("user-a")).toBe(0);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(req.listenerCount("close")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
    req.emit("close"); res.emit("close");
  });

  test.each(["request-close", "response-close"])("cleans up exactly once when %s happens first", async (first) => {
    const broker = new NotificationBroker(); const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    jest.spyOn(global, "setInterval").mockReturnValue(timer); const clear = jest.spyOn(global, "clearInterval").mockImplementation(() => undefined);
    const req = streamRequest(); const res = streamResponse();
    await createNotificationStreamHandler(broker)(req, res);
    if (first === "request-close") req.emit("close"); else res.emit("close");
    expect(broker.activeCount("user-a")).toBe(0);
    expect(clear).toHaveBeenCalledTimes(1);
    req.emit("aborted"); req.emit("close"); res.emit("close");
    expect(clear).toHaveBeenCalledTimes(1);
  });

  test("uses currentUser rather than a token claim to choose the stream owner", async () => {
    const req = new EventEmitter() as Request;
    (req as unknown as { authUser: unknown }).authUser = { uid: "attacker-controlled" };
    await expect(createNotificationStreamHandler(new NotificationBroker())(req, streamResponse())).rejects.toMatchObject({ statusCode: 401 });
  });

  test("rejects a fourth stream before emitting SSE headers", async () => {
    const broker = new NotificationBroker();
    for (let index = 0; index < 3; index++) broker.subscribe("user-a", streamResponse() as never);
    const res = streamResponse();
    await expect(createNotificationStreamHandler(broker)(streamRequest("user-a"), res)).rejects.toMatchObject({ statusCode: 429, code: "TOO_MANY_STREAMS" });
    expect(res.writes).toEqual([]);
  });

  test("registers stream before parameterized notification ID routes", () => {
    const router = createNotificationsRouter(undefined, new NotificationBroker());
    const paths = router.stack.map((layer) => layer.route?.path).filter(Boolean);
    expect(paths.indexOf("/stream")).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf("/stream")).toBeLessThan(paths.indexOf("/:notificationId"));
    expect(router.stack.slice(0, 4).map((layer) => layer.handle.name)).toEqual(["verifyFirebaseToken", "requireCurrentUser", "requireActiveUser", "requireVerifiedEmail"]);
  });

  test("rejects stream requests that do not pass each required authentication gate", async () => {
    const app = express(); app.use("/api/notifications", createNotificationsRouter(undefined, new NotificationBroker()));
    mockAuth.bearer = false; await request(app).get("/api/notifications/stream").expect(401);
    mockAuth.bearer = true; mockAuth.current = false; await request(app).get("/api/notifications/stream").expect(401);
    mockAuth.current = true; mockAuth.active = false; await request(app).get("/api/notifications/stream").expect(403);
    mockAuth.active = true; mockAuth.verified = false; await request(app).get("/api/notifications/stream").expect(403);
  });

  test("configures distinct stream-attempt and notification-write limiters", () => {
    process.env.ENABLE_CATEGORIES_JSON_FALLBACK = "true";
    let options: Array<{ max: number; windowMs: number; skip?: (req: { method: string }) => boolean }> = [];
    jest.isolateModules(() => {
      const rateLimit = require("express-rate-limit").default as jest.Mock;
      require("../../app");
      options = rateLimit.mock.calls.map(([value]) => value);
    });
    const stream = options.find((value) => value.max === 30 && value.windowMs === 5 * 60 * 1000);
    const writes = options.find((value) => value.max === 60 && value.windowMs === 5 * 60 * 1000 && value.skip);
    expect(stream).toBeDefined();
    expect(writes).toBeDefined();
    if (!writes?.skip) throw new Error("notification write limiter is not configured");
    expect(writes.skip({ method: "GET" })).toBe(true);
    expect(writes.skip({ method: "HEAD" })).toBe(true);
    expect(writes.skip({ method: "OPTIONS" })).toBe(true);
    expect(writes.skip({ method: "POST" })).toBe(false);
  });

  test("uses the configured production publisher for REST mutation signals", async () => {
    const broker = new NotificationBroker(); const res = streamResponse(); broker.subscribe("user-a", res as never);
    setNotificationPublisher(createNotificationPublisher(broker));
    const row = { id: "notification-1", userId: "user-a", type: "LISTING_APPROVED", category: "LISTINGS", title: "title", body: "body", actionUrl: null, entityType: null, entityId: null, metadata: {}, dedupeKey: null, aggregationKey: null, readAt: null, deletedAt: null, expiresAt: new Date(), createdAt: new Date(), updatedAt: new Date() };
    const service = createProductionNotificationsService({ markReadOwned: async () => ({ row, changed: true }), countUnread: async () => 2 } as never);

    await service.markRead("user-a", "notification-1");

    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"id":"notification-1","unreadCount":2,"version":1'));
  });
});
