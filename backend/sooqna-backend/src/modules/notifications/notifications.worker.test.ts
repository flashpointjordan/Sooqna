import { NotificationOutboxState, NotificationType } from "@prisma/client";
import { enqueueNotificationEvent } from "./notifications.producer";
import { createNotificationWorker, type NotificationOutboxRecord, type NotificationOutboxRepository } from "./notifications.worker";

const now = new Date("2026-08-24T10:00:00.000Z");

function event(overrides: Partial<NotificationOutboxRecord> = {}): NotificationOutboxRecord {
  return {
    id: "outbox-1", eventType: NotificationType.LISTING_APPROVED, aggregateType: "listing", aggregateId: "listing-1", recipientId: "user-1",
    payload: { eventType: "LISTING_APPROVED", recipientId: "user-1", listingId: "listing-1", listingTitle: "Laptop" }, dedupeKey: "listing-1:approved",
    state: NotificationOutboxState.PENDING, attempts: 0, availableAt: now, processedAt: null, lastError: null, createdAt: now, updatedAt: now, ...overrides,
  };
}

class FakeOutboxRepository implements NotificationOutboxRepository {
  rows: NotificationOutboxRecord[];
  marks: Array<{ id: string; state: "PROCESSED" | "FAILED"; availableAt?: Date; error?: string }> = [];
  claims = 0;
  constructor(rows: NotificationOutboxRecord[]) { this.rows = rows; }
  async recoverStaleProcessing(recoveredAt: Date, staleBefore: Date) {
    let recovered = 0;
    for (const row of this.rows) if (row.state === NotificationOutboxState.PROCESSING && row.updatedAt < staleBefore) { row.state = NotificationOutboxState.FAILED; row.availableAt = recoveredAt; recovered++; }
    return recovered;
  }
  async claimReady(limit: number, claimedAt: Date) {
    this.claims++;
    return this.rows.filter((row) => (row.state === NotificationOutboxState.PENDING || row.state === NotificationOutboxState.FAILED) && row.availableAt <= claimedAt)
      .slice(0, limit).map((row) => ({ ...row, state: row.state = NotificationOutboxState.PROCESSING, attempts: row.attempts = row.attempts + 1 }));
  }
  async markProcessed(id: string, _processedAt: Date) { this.marks.push({ id, state: "PROCESSED" }); const row = this.rows.find((candidate) => candidate.id === id)!; row.state = NotificationOutboxState.PROCESSED; }
  async markFailure(id: string, error: string, availableAt: Date, _failedAt: Date) { this.marks.push({ id, state: "FAILED", error, availableAt }); const row = this.rows.find((candidate) => candidate.id === id)!; row.lastError = error; row.availableAt = availableAt; row.state = row.attempts >= 8 ? NotificationOutboxState.DEAD : NotificationOutboxState.FAILED; return row.state; }
}

function service() {
  return { persistFromEvent: jest.fn(async (..._args: unknown[]) => ({ row: { id: "notification-1", userId: "user-1" }, changed: true })), unreadCount: jest.fn(async () => 1), signalPersisted: jest.fn(async () => undefined) };
}

describe("notification outbox worker", () => {
  test("producer upserts one fact-only event by deterministic dedupe key", async () => {
    const upsert = jest.fn(async (query: { create: { dedupeKey: string } }) => ({ id: "outbox-1", ...query.create }));
    const payload = { eventType: "LISTING_APPROVED" as const, recipientId: "user-1", listingId: "listing-1", listingTitle: "Laptop" };
    const result = await enqueueNotificationEvent({ payload, aggregateType: "listing", aggregateId: "listing-1", dedupeKey: "listing-1:approved" }, { notificationOutbox: { upsert } } as never);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({ where: { dedupeKey: "listing-1:approved" }, update: {}, create: { payload, attempts: 0, state: NotificationOutboxState.PENDING } });
    expect(result).toMatchObject({ dedupeKey: "listing-1:approved", payload });
    expect(upsert.mock.calls[0][0].create).not.toHaveProperty("title");
  });

  test("persists and signals before marking a ready event processed", async () => {
    const repo = new FakeOutboxRepository([event()]); const notifications = service(); const order: string[] = [];
    notifications.persistFromEvent.mockImplementation(async () => { order.push("persist-and-signal"); return { row: { id: "notification-1", userId: "user-1" }, changed: true }; });
    const worker = createNotificationWorker({ repository: repo, service: notifications, now: () => now, processEvent: async (row) => { order.push("process"); await notifications.persistFromEvent(row.eventType, row.payload as never, { dedupeKey: row.dedupeKey }); } });
    await worker.runOnce();
    expect(order).toEqual(["process", "persist-and-signal"]);
    expect(repo.marks).toEqual([{ id: "outbox-1", state: "PROCESSED" }]);
  });

  test("backs off a failed event with injected jitter and caps its stored error", async () => {
    const repo = new FakeOutboxRepository([event({ attempts: 4 })]);
    const worker = createNotificationWorker({ repository: repo, service: service(), now: () => now, jitter: () => 77, processEvent: async () => { throw new Error("x".repeat(700)); } });
    await worker.runOnce();
    expect(repo.marks[0]).toMatchObject({ state: "FAILED", error: "x".repeat(500), availableAt: new Date(now.getTime() + 16_077) });
  });

  test("makes the eighth failed attempt dead", async () => {
    const repo = new FakeOutboxRepository([event({ attempts: 7 })]);
    const worker = createNotificationWorker({ repository: repo, service: service(), now: () => now, processEvent: async () => { throw new Error("boom"); } });
    await worker.runOnce();
    expect(repo.rows[0].state).toBe(NotificationOutboxState.DEAD);
  });

  test("marks disabled optional and unchanged aggregate events processed without publishing", async () => {
    const repo = new FakeOutboxRepository([event()]); const notifications = service();
    notifications.persistFromEvent.mockResolvedValueOnce({ row: null, changed: false } as never);
    const worker = createNotificationWorker({ repository: repo, service: notifications, now: () => now });
    await worker.runOnce();
    expect(notifications.signalPersisted).not.toHaveBeenCalled();
    expect(repo.rows[0].state).toBe(NotificationOutboxState.PROCESSED);

    repo.rows = [event({ eventType: NotificationType.LISTING_FAVORITED_AGGREGATE, payload: { eventType: "LISTING_FAVORITED_AGGREGATE", recipientId: "user-1", listingId: "listing-1", listingTitle: "Laptop", favoriteCount: 2 } })];
    notifications.persistFromEvent.mockResolvedValueOnce({ row: { id: "notification-1", userId: "user-1" }, changed: false });
    await worker.runOnce();
    expect(notifications.signalPersisted).not.toHaveBeenCalled();
    expect(repo.rows[0].state).toBe(NotificationOutboxState.PROCESSED);
  });

  test("processes a security event and uses an injected publisher after persistence", async () => {
    const repo = new FakeOutboxRepository([event({ eventType: NotificationType.SECURITY_ALERT, payload: { eventType: "SECURITY_ALERT", recipientId: "user-1", alertId: "alert-1" } })]);
    const publishSignal = jest.fn(async () => undefined);
    const worker = createNotificationWorker({ repository: repo, service: service(), now: () => now, publishSignal });
    await worker.runOnce();
    expect(publishSignal).toHaveBeenCalledWith("user-1", "notification-1", 1);
    expect(repo.rows[0].state).toBe(NotificationOutboxState.PROCESSED);
  });

  test("re-publishes a persisted normal event after an earlier signal failure", async () => {
    const repo = new FakeOutboxRepository([event()]); const notifications = service();
    notifications.persistFromEvent.mockResolvedValueOnce({ row: { id: "notification-1", userId: "user-1" }, changed: true }).mockResolvedValueOnce({ row: { id: "notification-1", userId: "user-1" }, changed: false });
    const publishSignal = jest.fn().mockRejectedValueOnce(new Error("broker offline")).mockResolvedValueOnce(undefined);
    const worker = createNotificationWorker({ repository: repo, service: notifications, now: () => now, publishSignal, jitter: () => 0 });
    await worker.runOnce();
    repo.rows[0].availableAt = now;
    await worker.runOnce();
    expect(publishSignal).toHaveBeenCalledTimes(2);
    expect(repo.rows[0].state).toBe(NotificationOutboxState.PROCESSED);
  });

  test("recovers stale processing rows before claiming and awaits active work on stop", async () => {
    const stale = event({ id: "stale", state: NotificationOutboxState.PROCESSING, updatedAt: new Date(now.getTime() - 6 * 60_000) });
    const repo = new FakeOutboxRepository([stale]); let resolve!: () => void;
    const worker = createNotificationWorker({ repository: repo, service: service(), now: () => now, processEvent: () => new Promise<void>((done) => { resolve = done; }) });
    const run = worker.runOnce();
    await new Promise<void>((done) => setImmediate(done));
    const stopping = worker.stop();
    expect(repo.claims).toBe(1);
    resolve(); await run; await stopping;
    expect(repo.rows[0].state).toBe(NotificationOutboxState.PROCESSED);
  });

  test("unrefs its poll timer and stops future claims", async () => {
    const repo = new FakeOutboxRepository([]); const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = jest.spyOn(global, "setInterval").mockReturnValue(timer);
    const clearIntervalSpy = jest.spyOn(global, "clearInterval").mockImplementation(() => undefined);
    const worker = createNotificationWorker({ repository: repo, service: service(), now: () => now });
    worker.start(); await new Promise<void>((done) => setImmediate(done)); await worker.stop();
    expect(timer.unref).toHaveBeenCalled();
    const claimsAfterStop = repo.claims;
    await worker.runOnce();
    expect(repo.claims).toBe(claimsAfterStop);
    setIntervalSpy.mockRestore(); clearIntervalSpy.mockRestore();
  });

  test("constructs server lifecycle without binding a port", async () => {
    process.env.ENABLE_CATEGORIES_JSON_FALLBACK = "true";
    const info = jest.spyOn(console, "info").mockImplementation(() => undefined);
    const { createServerLifecycle } = await import("../../server");
    const worker = { start: jest.fn(), stop: jest.fn(async () => undefined) };
    const listen = jest.fn(); const disconnect = jest.fn(async () => undefined);
    const lifecycle = createServerLifecycle({ worker: worker as never, listen, disconnect });
    expect(listen).not.toHaveBeenCalled();
    await lifecycle.stop();
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });
});
