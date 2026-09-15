import request from "supertest";

const mockOperationsSchedulerState = jest.fn(() => "running");
const mockDeliveryWorkerState = jest.fn(() => "running");

jest.mock("../modules/notifications/notifications.operations", () => ({
  createNotificationOperationsRepository: () => ({}),
  getNotificationOperationsWorkerState: () => mockOperationsSchedulerState(),
  NotificationOperationsService: jest.fn().mockImplementation(() => ({
    health: async (runtime: Record<string, unknown>) => ({ queueDepth: 2, oldestPendingAgeMs: 5_000, deadCount: 1, ...runtime }),
  })),
}));
jest.mock("../modules/notifications/notifications.worker", () => ({
  getNotificationDeliveryWorkerState: () => mockDeliveryWorkerState(),
}));

import { app } from "../app";

describe("GET /api/health", () => {
  beforeEach(() => {
    mockDeliveryWorkerState.mockReturnValue("running");
    mockOperationsSchedulerState.mockReturnValue("running");
  });

  it("returns ready only while both notification workers are running", async () => {
    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe("ok");
    expect(response.body.data.ready).toBe(true);
    expect(response.body.data.notifications).toEqual(expect.objectContaining({
      queueDepth: expect.any(Number),
      deadCount: expect.any(Number),
      workerState: "running",
      operationsSchedulerState: "running",
      activeStreams: expect.any(Number),
    }));
    expect(JSON.stringify(response.body.data.notifications)).not.toMatch(/userId|recipientId|title|body|payload/i);
  });

  it.each(["error", "stopped"])("returns degraded readiness when delivery worker is %s while operations run", async (workerState) => {
    mockDeliveryWorkerState.mockReturnValue(workerState);

    const response = await request(app).get("/api/health");

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.data).toMatchObject({ status: "degraded", ready: false });
    expect(response.body.data.notifications).toMatchObject({ workerState, operationsSchedulerState: "running" });
  });

  it("reports startup as not ready before notification workers begin", async () => {
    mockDeliveryWorkerState.mockReturnValue("idle");

    const response = await request(app).get("/api/health");

    expect(response.status).toBe(503);
    expect(response.body.data).toMatchObject({ status: "starting", ready: false });
  });
});
