import { NotificationOutboxState, NotificationType } from "@prisma/client";
import { enqueueNotificationEvent } from "./notifications.producer";
import { createNotificationWorker, getNotificationDeliveryWorkerState, runNotificationWorkerOnce, type NotificationOutboxRecord, type NotificationOutboxRepository } from "./notifications.worker";

const now = new Date("2026-08-24T10:00:00.000Z");

function event(overrides: Partial<NotificationOutboxRecord> = {}): NotificationOutboxRecord {
  return {
    id: "outbox-1", eventType: NotificationType.LISTING_APPROVED, aggregateType: "listing", aggregateId: "listing-1", recipientId: "user-1",
    payload: { eventType: "LISTING_APPROVED", recipientId: "user-1", listingId: "listing-1", listingTitle: "Laptop" }, dedupeKey: "listing-1:approved",
    state: NotificationOutboxState.PENDING, attempts: 0, claimAttempt: 0, availableAt: now, processedAt: null, lastError: null, createdAt: now, updatedAt: now, ...overrides,
  };
}

class FakeOutboxRepository implements NotificationOutboxRepository {
  rows: NotificationOutboxRecord[];
  marks: Array<{ id: string; state: "PROCESSED" | "FAILED"; availableAt?: Date; error?: string }> = [];
  claims = 0;
  constructor(rows: NotificationOutboxRecord[]) { this.rows = rows; }
  async recoverStaleProcessing(recoveredAt: Date, staleBefore: Date) {
    let recovered = 0; const dead: Array<{ id: string; attempts: number }> = [];
    for (const row of this.rows) if (row.state === NotificationOutboxState.PROCESSING && row.updatedAt < staleBefore) { row.state = row.attempts >= 8 ? NotificationOutboxState.DEAD : NotificationOutboxState.FAILED; row.availableAt = recoveredAt; recovered++; if (row.state === NotificationOutboxState.DEAD) dead.push({ id: row.id, attempts: row.attempts }); }
    return { recovered, dead };
  }
  async claimReady(limit: number, claimedAt: Date) {
    this.claims++;
    return this.rows.filter((row) => (row.state === NotificationOutboxState.PENDING || row.state === NotificationOutboxState.FAILED) && row.attempts < 8 && row.availableAt <= claimedAt)
      .slice(0, limit).map((row) => ({ ...row, state: row.state = NotificationOutboxState.PROCESSING, attempts: row.attempts = row.attempts + 1, claimAttempt: row.attempts }));
  }
  async markProcessed(id: string, claimAttempt: number, _processedAt: Date) { const row = this.rows.find((candidate) => candidate.id === id)!; if (row.state !== NotificationOutboxState.PROCESSING || row.attempts !== claimAttempt) return false; this.marks.push({ id, state: "PROCESSED" }); row.state = NotificationOutboxState.PROCESSED; return true; }
  async markFailure(id: string, claimAttempt: number, error: string, availableAt: Date, _failedAt: Date) { const row = this.rows.find((candidate) => candidate.id === id)!; if (row.state !== NotificationOutboxState.PROCESSING || row.attempts !== claimAttempt) return row.state; this.marks.push({ id, state: "FAILED", error, availableAt }); row.lastError = error; row.availableAt = availableAt; row.state = row.attempts >= 8 ? NotificationOutboxState.DEAD : NotificationOutboxState.FAILED; return row.state; }
}

function service() {
  return { persistFromEvent: jest.fn(async (..._args: unknown[]) => ({ row: { id: "notification-1", userId: "user-1" }, changed: true })), unreadCount: jest.fn(async () => 1), signalPersisted: jest.fn(async () => undefined) };
}

describe("notification outbox worker", () => {
  test("reports bounded operational worker states without exposing event data", async () => {
    const worker = createNotificationWorker({ repository: new FakeOutboxRepository([]), service: service(), now: () => now });
    expect(worker.health()).toEqual({ state: "idle" });
    const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    jest.spyOn(global, "setInterval").mockReturnValueOnce(timer);
    worker.start();
    expect(worker.health()).toEqual({ state: "running" });
    expect(getNotificationDeliveryWorkerState()).toBe("running");
    await worker.stop();
    expect(worker.health()).toEqual({ state: "stopped" });
    expect(getNotificationDeliveryWorkerState()).toBe("stopped");
  });

  test("runs listing lifecycle maintenance at most once per UTC hour", async () => {
    const clock = { value: new Date("2026-09-12T08:01:00.000Z") };
    const lifecycle = jest.fn<Promise<void>, [Date]>(async () => undefined);
    const worker = createNotificationWorker({ repository: new FakeOutboxRepository([]), service: service(), now: () => clock.value, runLifecycle: lifecycle });
    await worker.runOnce();
    clock.value = new Date("2026-09-12T08:59:00.000Z");
    await worker.runOnce();
    clock.value = new Date("2026-09-12T09:00:00.000Z");
    await worker.runOnce();
    expect(lifecycle.mock.calls.map(([at]) => at.toISOString())).toEqual([
      "2026-09-12T08:01:00.000Z",
      "2026-09-12T09:00:00.000Z",
    ]);
  });

  test("keeps outbox delivery running when hourly listing lifecycle maintenance fails", async () => {
    const repo = new FakeOutboxRepository([event()]);
    const logger = { error: jest.fn() };
    const worker = createNotificationWorker({
      repository: repo,
      service: service(),
      now: () => now,
      logger,
      runLifecycle: async () => { throw new Error("lifecycle unavailable"); },
    });
    await worker.runOnce();
    await worker.runOnce();
    expect(repo.marks).toEqual([{ id: "outbox-1", state: "PROCESSED" }]);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith("Listing notification lifecycle failed.", { error: "lifecycle unavailable" });
  });

  test("producer upserts one fact-only event by deterministic dedupe key", async () => {
    const upsert = jest.fn(async (query: { create: { dedupeKey: string } }) => ({ id: "outbox-1", ...query.create }));
    const payload = { eventType: "LISTING_APPROVED" as const, recipientId: "user-1", listingId: "listing-1", listingTitle: "Laptop" };
    const result = await enqueueNotificationEvent({ payload, aggregateType: "listing", aggregateId: "listing-1", dedupeKey: "listing-1:approved" }, { notificationOutbox: { upsert } } as never);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({ where: { dedupeKey: "listing-1:approved" }, update: {}, create: { payload, attempts: 0, state: NotificationOutboxState.PENDING } });
    expect(result).toMatchObject({ dedupeKey: "listing-1:approved", payload });
    expect(upsert.mock.calls[0][0].create).not.toHaveProperty("title");
  });

  test("producer strips rendered and private extras before recording facts", async () => {
    const upsert = jest.fn(async (query: { create: { payload: unknown } }) => ({ id: "outbox-1", ...query.create }));
    const unsafePayload = { eventType: "LISTING_APPROVED", recipientId: "user-1", listingId: "listing-1", listingTitle: "Laptop", title: "عنوان مرسوم", body: "نسخة خاصة", token: "secret", email: "user@example.test", password: "secret", unknown: true };
    await enqueueNotificationEvent({ payload: unsafePayload as never, aggregateType: "listing", aggregateId: "listing-1", dedupeKey: "listing-1:approved" }, { notificationOutbox: { upsert } } as never);
    expect(upsert.mock.calls[0][0].create.payload).toEqual({ eventType: "LISTING_APPROVED", recipientId: "user-1", listingId: "listing-1", listingTitle: "Laptop" });
  });

  test("persists and signals before marking a ready event processed", async () => {
    const repo = new FakeOutboxRepository([event()]); const notifications = service(); const order: string[] = [];
    notifications.persistFromEvent.mockImplementation(async () => { order.push("persist-and-signal"); return { row: { id: "notification-1", userId: "user-1" }, changed: true }; });
    const worker = createNotificationWorker({ repository: repo, service: notifications, now: () => now, processEvent: async (row) => { order.push("process"); await notifications.persistFromEvent(row.eventType, row.payload as never, { dedupeKey: row.dedupeKey }); } });
    await worker.runOnce();
    expect(order).toEqual(["process", "persist-and-signal"]);
    expect(repo.marks).toEqual([{ id: "outbox-1", state: "PROCESSED" }]);
  });

  test("does not publish a late message event whose authoritative projection is already read", async () => {
    const repo = new FakeOutboxRepository([event({
      eventType: NotificationType.MESSAGE_RECEIVED,
      aggregateType: "message",
      aggregateId: "msg-1",
      recipientId: "recipient-1",
      dedupeKey: "message:msg-1:recipient-1",
      payload: {
        eventType: NotificationType.MESSAGE_RECEIVED,
        recipientId: "recipient-1",
        conversationId: "conv-1",
        messageId: "msg-1",
        senderId: "sender-1",
        senderName: "Sender",
        listingId: "listing-1",
        messagePreview: "Hello",
      },
    })]);
    const notifications = service() as ReturnType<typeof service> & {
      persistMessageProjection: jest.Mock;
    };
    notifications.persistMessageProjection = jest.fn(async () => ({
      row: { id: "notification-1", userId: "recipient-1" },
      changed: true,
      shouldSignal: false,
    }));
    const publishSignal = jest.fn();
    const worker = createNotificationWorker({ repository: repo, service: notifications, now: () => now, publishSignal });

    await worker.runOnce();

    expect(notifications.persistMessageProjection).toHaveBeenCalledTimes(1);
    expect(notifications.persistFromEvent).not.toHaveBeenCalled();
    expect(notifications.unreadCount).not.toHaveBeenCalled();
    expect(publishSignal).not.toHaveBeenCalled();
    expect(repo.rows[0].state).toBe(NotificationOutboxState.PROCESSED);
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

    repo.rows = [event({ eventType: NotificationType.LISTING_FAVORITED_AGGREGATE, payload: { eventType: "LISTING_FAVORITED_AGGREGATE", recipientId: "user-1", listingId: "listing-1", listingTitle: "Laptop", favoriteCount: 2, sourceTimestamp: "2026-08-24T09:59:00.000Z", sourceId: "favorite-cycle-1", sourceVersion: "1" } })];
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

  test("uses an hourly aggregate key for saved-search matches", async () => {
    const repo = new FakeOutboxRepository([event({ eventType: NotificationType.SAVED_SEARCH_MATCHES, aggregateType: "savedSearch", aggregateId: "search-1", payload: { eventType: "SAVED_SEARCH_MATCHES", recipientId: "user-1", savedSearchId: "search-1", savedSearchName: "Laptops", query: {}, matchingListingIds: ["listing-1"], totalCount: 1 } })]);
    const notifications = service();
    const worker = createNotificationWorker({ repository: repo, service: notifications, now: () => now });
    await worker.runOnce();
    expect(notifications.persistFromEvent).toHaveBeenCalledWith(NotificationType.SAVED_SEARCH_MATCHES, expect.anything(), { dedupeKey: "listing-1:approved", aggregationKey: "SAVED_SEARCH_MATCHES:user-1:search-1:2026-08-24T10" });
  });

  test("keeps an aggregate key in its creation-hour across delayed retry", async () => {
    const createdAt = new Date("2026-08-24T09:59:00.000Z"); let processingNow = new Date("2026-08-24T10:01:00.000Z");
    const repo = new FakeOutboxRepository([event({ eventType: NotificationType.SAVED_SEARCH_MATCHES, aggregateType: "savedSearch", aggregateId: "search-1", createdAt, payload: { eventType: "SAVED_SEARCH_MATCHES", recipientId: "user-1", savedSearchId: "search-1", savedSearchName: "Laptops", query: {}, matchingListingIds: ["listing-1"], totalCount: 1 } })]);
    const notifications = service(); notifications.persistFromEvent.mockResolvedValueOnce({ row: { id: "notification-1", userId: "user-1" }, changed: true }).mockResolvedValueOnce({ row: { id: "notification-1", userId: "user-1" }, changed: false });
    const publishSignal = jest.fn().mockRejectedValueOnce(new Error("broker offline")).mockResolvedValueOnce(undefined);
    const worker = createNotificationWorker({ repository: repo, service: notifications, now: () => processingNow, publishSignal, jitter: () => 0 });
    await worker.runOnce(); repo.rows[0].availableAt = processingNow; processingNow = new Date("2026-08-24T11:01:00.000Z"); await worker.runOnce();
    expect(notifications.persistFromEvent.mock.calls.map((call) => (call[2] as { aggregationKey?: string } | undefined)?.aggregationKey)).toEqual(["SAVED_SEARCH_MATCHES:user-1:search-1:2026-08-24T09", "SAVED_SEARCH_MATCHES:user-1:search-1:2026-08-24T09"]);
  });

  test("preserves an explicit complete aggregate key", async () => {
    const repo = new FakeOutboxRepository([event({ eventType: NotificationType.SAVED_SEARCH_MATCHES, aggregateType: "savedSearch", aggregateId: "search-1", createdAt: new Date("2026-08-24T09:59:00.000Z"), payload: { eventType: "SAVED_SEARCH_MATCHES", recipientId: "user-1", savedSearchId: "search-1", savedSearchName: "Laptops", query: {}, matchingListingIds: ["listing-1"], totalCount: 1, _aggregationKey: "campaign-7:2026-08-24T08" } })]);
    const notifications = service(); await createNotificationWorker({ repository: repo, service: notifications, now: () => new Date("2026-08-24T10:01:00.000Z") }).runOnce();
    expect((notifications.persistFromEvent.mock.calls[0][2] as { aggregationKey?: string }).aggregationKey).toBe("campaign-7:2026-08-24T08");
  });

  test("re-publishes an aggregate notification after signal failure before processing it", async () => {
    const repo = new FakeOutboxRepository([event({ eventType: NotificationType.LISTING_FAVORITED_AGGREGATE, payload: { eventType: "LISTING_FAVORITED_AGGREGATE", recipientId: "user-1", listingId: "listing-1", listingTitle: "Laptop", favoriteCount: 2, sourceTimestamp: "2026-08-24T09:59:00.000Z", sourceId: "favorite-cycle-1", sourceVersion: "1" } })]);
    const notifications = service();
    notifications.persistFromEvent.mockResolvedValueOnce({ row: { id: "notification-1", userId: "user-1" }, changed: true }).mockResolvedValueOnce({ row: { id: "notification-1", userId: "user-1" }, changed: false });
    const publishSignal = jest.fn().mockRejectedValueOnce(new Error("broker offline")).mockResolvedValueOnce(undefined);
    const worker = createNotificationWorker({ repository: repo, service: notifications, now: () => now, publishSignal, jitter: () => 0 });
    await worker.runOnce(); repo.rows[0].availableAt = now; await worker.runOnce();
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

  test("finishes every row already claimed when stop begins", async () => {
    const repo = new FakeOutboxRepository([event({ id: "one" }), event({ id: "two" })]); let resolveFirst!: () => void;
    const worker = createNotificationWorker({ repository: repo, service: service(), now: () => now, processEvent: (row) => row.id === "one" ? new Promise<void>((done) => { resolveFirst = done; }) : Promise.resolve() });
    const run = worker.runOnce(); await new Promise<void>((done) => setImmediate(done)); const stopping = worker.stop();
    resolveFirst(); await run; await stopping;
    expect(repo.rows.map((row) => row.state)).toEqual([NotificationOutboxState.PROCESSED, NotificationOutboxState.PROCESSED]);
  });

  test("does not process a stale crashed eighth-attempt row", async () => {
    const repo = new FakeOutboxRepository([event({ attempts: 8, state: NotificationOutboxState.PROCESSING, updatedAt: new Date(now.getTime() - 6 * 60_000) })]);
    const processEvent = jest.fn(async () => undefined);
    const worker = createNotificationWorker({ repository: repo, service: service(), now: () => now, processEvent });
    await worker.runOnce();
    expect(processEvent).not.toHaveBeenCalled();
    expect(repo.rows[0].state).toBe(NotificationOutboxState.DEAD);
  });

  test("logs a structured dead-letter event when stale eighth attempt is recovered", async () => {
    const repo = new FakeOutboxRepository([event({ id: "dead-row", attempts: 8, state: NotificationOutboxState.PROCESSING, updatedAt: new Date(now.getTime() - 6 * 60_000) })]);
    const logger = { error: jest.fn() };
    await createNotificationWorker({ repository: repo, service: service(), now: () => now, logger }).runOnce();
    expect(logger.error).toHaveBeenCalledWith("Notification outbox event is dead.", { outboxId: "dead-row", attempts: 8, reason: "stale_processing" });
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

  test("catches scheduler errors and permits the next scheduled claim", async () => {
    let tick!: () => void; const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    const repository: NotificationOutboxRepository = {
      recoverStaleProcessing: jest.fn().mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValue({ recovered: 0, dead: [] }),
      claimReady: jest.fn(async () => []), markProcessed: jest.fn(async () => false), markFailure: jest.fn(async () => NotificationOutboxState.FAILED),
    };
    const logger = { error: jest.fn() };
    const interval = jest.spyOn(global, "setInterval").mockImplementation((callback) => { tick = callback as () => void; return timer; });
    const clear = jest.spyOn(global, "clearInterval").mockImplementation(() => undefined);
    const worker = createNotificationWorker({ repository, service: service(), logger });
    worker.start(); await new Promise<void>((done) => setImmediate(done)); tick(); await new Promise<void>((done) => setImmediate(done)); await worker.stop();
    expect(logger.error).toHaveBeenCalledWith("Notification worker run failed.", expect.objectContaining({ error: "database unavailable" }));
    expect(repository.claimReady).toHaveBeenCalledTimes(1);
    interval.mockRestore(); clear.mockRestore();
  });

  test("fences an old claim completion after the row is reclaimed", async () => {
    const repo = new FakeOutboxRepository([event({ state: NotificationOutboxState.PROCESSING, attempts: 2 })]);
    repo.rows[0].attempts = 3;
    await (repo as unknown as { markProcessed(id: string, attempt: number, now: Date): Promise<boolean> }).markProcessed("outbox-1", 2, now);
    expect(repo.rows[0].state).toBe(NotificationOutboxState.PROCESSING);
  });

  test("one-shot runner disconnects even when processing fails", async () => {
    const failure = new Error("claim failed"); const disconnect = jest.fn(async () => undefined);
    await expect(runNotificationWorkerOnce({ worker: { runOnce: jest.fn(async () => { throw failure; }) }, disconnect })).rejects.toBe(failure);
    expect(disconnect).toHaveBeenCalledTimes(1);
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

  test("server closes listeners before bounded worker drain and always disconnects", async () => {
    process.env.ENABLE_CATEGORIES_JSON_FALLBACK = "true";
    const { createServerLifecycle } = await import("../../server"); const order: string[] = [];
    const info = jest.spyOn(console, "info").mockImplementation(() => undefined); const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const worker = { start: jest.fn(), stop: jest.fn(() => new Promise<void>(() => { order.push("worker-stop"); })) };
    const server = { close: (callback: (error?: Error) => void) => { order.push("http-close"); callback(); } };
    const lifecycle = createServerLifecycle({ worker: worker as never, listen: ((_port: number, ready: () => void) => { ready(); return server as never; }) as never, disconnect: async () => { order.push("disconnect"); }, drainTimeoutMs: 1 } as never);
    lifecycle.start();
    const settled = await Promise.race([lifecycle.stop().then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30))]);
    expect(settled).toBe(true);
    expect(order).toEqual(["http-close", "worker-stop", "disconnect"]);
    info.mockRestore(); warn.mockRestore();
  });
});
