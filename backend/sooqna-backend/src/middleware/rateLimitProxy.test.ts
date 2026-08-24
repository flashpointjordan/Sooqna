import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";

describe("rate limiting behind one trusted proxy", () => {
  it("keeps forwarded client buckets independent", async () => {
    const testApp = express();
    testApp.set("trust proxy", 1);
    testApp.use(rateLimit({ windowMs: 60_000, max: 1 }));
    testApp.get("/test", (_req, res) => res.sendStatus(200));

    const first = await request(testApp)
      .get("/test")
      .set("X-Forwarded-For", "203.0.113.1");
    const firstAgain = await request(testApp)
      .get("/test")
      .set("X-Forwarded-For", "203.0.113.1");
    const second = await request(testApp)
      .get("/test")
      .set("X-Forwarded-For", "203.0.113.2");

    expect(first.status).toBe(200);
    expect(firstAgain.status).toBe(429);
    expect(second.status).toBe(200);
  });
});
