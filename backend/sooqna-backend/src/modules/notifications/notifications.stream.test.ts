import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
jest.mock("express-rate-limit", () => ({ __esModule: true, default: jest.fn((options) => {
  const middleware = (_req: Request, _res: Response, next: () => void) => next();
  return Object.assign(middleware, { options });
}) }));
jest.mock("../../routes", () => {
  const express = require("express");
  return { apiRouter: express.Router() };
});
jest.mock("./notifications.repository", () => ({ PrismaNotificationsRepository: class {} }));
jest.mock("../../middleware/verifyFirebaseToken", () => ({ verifyFirebaseToken: (_req: Request, _res: Response, next: () => void) => next() }));
jest.mock("../../middleware/authContext", () => ({ requireCurrentUser: (_req: Request, _res: Response, next: () => void) => next(), requireActiveUser: (_req: Request, _res: Response, next: () => void) => next() }));
jest.mock("../../middleware/requireVerifiedEmail", () => ({ requireVerifiedEmail: (_req: Request, _res: Response, next: () => void) => next() }));
import { NotificationBroker } from "./notifications.broker";
import { createNotificationStreamHandler } from "./notifications.controller";
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
  afterEach(() => jest.restoreAllMocks());

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
    expect(writes.skip({ method: "POST" })).toBe(false);
  });
});
