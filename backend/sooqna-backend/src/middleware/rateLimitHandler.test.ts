import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { logger } from "../config/logger";
import { createRateLimitHandler } from "./rateLimitHandler";

describe("rate-limit rejection diagnostics", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns the configured body and logs only privacy-safe metadata", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    const testApp = express();
    const body = {
      success: false,
      code: "RATE_LIMITED",
      message: "Too many messaging requests.",
    };

    testApp.use(
      rateLimit({
        windowMs: 60_000,
        max: 1,
        standardHeaders: true,
        legacyHeaders: false,
        handler: createRateLimitHandler("messages", body),
      })
    );
    testApp.get("/api/messages/conversations", (_req, res) => res.sendStatus(200));

    await request(testApp).get("/api/messages/conversations");
    const limited = await request(testApp).get("/api/messages/conversations");

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual(body);
    expect(warn).toHaveBeenCalledTimes(1);

    const [message, meta] = warn.mock.calls[0];
    expect(message).toBe("rate_limit_exceeded");
    expect(meta).toMatchObject({
      limiter: "messages",
      method: "GET",
      path: "/api/messages/conversations",
      clientIp: expect.any(String),
      retryAfter: expect.any(String),
    });
    expect(Object.keys(meta ?? {}).sort()).toEqual(
      ["clientIp", "limiter", "method", "path", "retryAfter"].sort()
    );
  });
});
