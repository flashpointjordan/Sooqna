import request from "supertest";

jest.mock("../modules/notifications/notifications.operations", () => ({
  createNotificationOperationsRepository: () => ({}),
  getNotificationOperationsWorkerState: () => "running",
  NotificationOperationsService: jest.fn().mockImplementation(() => ({
    health: async () => ({ queueDepth: 2, oldestPendingAgeMs: 5_000, deadCount: 1, workerState: "running", activeStreams: 0 }),
  })),
}));

import { app } from "../app";

describe("GET /api/health", () => {
  it("returns ok status", async () => {
    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe("ok");
    expect(response.body.data.notifications).toEqual(expect.objectContaining({
      queueDepth: expect.any(Number),
      deadCount: expect.any(Number),
      workerState: expect.any(String),
      activeStreams: expect.any(Number),
    }));
    expect(JSON.stringify(response.body.data.notifications)).not.toMatch(/userId|recipientId|title|body|payload/i);
  });
});
