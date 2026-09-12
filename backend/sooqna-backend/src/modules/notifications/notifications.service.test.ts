import { NotificationCategory, NotificationType } from "@prisma/client";
import { decodeNotificationCursor, encodeNotificationCursor } from "./notifications.types";
import { NotificationsService, type NotificationsRepository, type StoredNotification } from "./notifications.service";
import { mergeSavedSearchAggregate } from "./notifications.aggregate";

const now = new Date("2026-08-24T12:00:00.000Z");
const active = (id: string, overrides: Partial<StoredNotification> = {}): StoredNotification => ({
  id, userId: "user-a", type: NotificationType.LISTING_APPROVED, category: NotificationCategory.LISTINGS,
  title: "title", body: "body", actionUrl: "/listings/listing-1", entityType: "listing", entityId: "listing-1",
  metadata: { listingId: "listing-1" }, dedupeKey: null, aggregationKey: null, readAt: null, deletedAt: null,
  expiresAt: new Date("2026-11-23T12:00:00.000Z"), createdAt: new Date("2026-08-24T11:00:00.000Z"), updatedAt: now,
  ...overrides,
});

class MemoryRepo implements NotificationsRepository {
  rows: StoredNotification[] = [];
  preferences = new Map<string, boolean>();
  outboxEvents = new Map<string, "PENDING" | "PROCESSING" | "PROCESSED">();
  async listActive(userId: string, query: { limit: number; cursor?: string; category?: NotificationCategory; unread?: boolean }, at: Date) {
    let rows = this.rows.filter((row) => row.userId === userId && !row.deletedAt && row.expiresAt > at && (!query.category || row.category === query.category) && (query.unread === undefined || (query.unread ? !row.readAt : !!row.readAt)));
    rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    if (query.cursor) { const { createdAt, id } = decodeNotificationCursor(query.cursor); rows = rows.filter((row) => row.createdAt < new Date(createdAt) || (row.createdAt.getTime() === new Date(createdAt).getTime() && row.id < id)); }
    const page = rows.slice(0, Math.min(query.limit, 50));
    return { items: page, hasMore: rows.length > page.length, nextCursor: page.length && rows.length > page.length ? encodeNotificationCursor({ createdAt: page.at(-1)!.createdAt.toISOString(), id: page.at(-1)!.id }) : null };
  }
  async countUnread(userId: string, at: Date) { return this.rows.filter((r) => r.userId === userId && !r.deletedAt && r.expiresAt > at && !r.readAt).length; }
  async findActiveOwned(userId: string, id: string, at: Date) { return this.rows.find((r) => r.userId === userId && r.id === id && !r.deletedAt && r.expiresAt > at) ?? null; }
  async markReadOwned(userId: string, id: string, at: Date) { const row = await this.findActiveOwned(userId, id, at); const changed = Boolean(row && !row.readAt); if (row && changed) row.readAt = at; return row ? { row, changed } : null; }
  async markAllRead(userId: string, at: Date) { let count = 0; for (const row of this.rows) if (row.userId === userId && !row.deletedAt && row.expiresAt > at && !row.readAt) { row.readAt = at; count++; } return count; }
  async softDeleteOwned(userId: string, id: string, at: Date) { const row = this.rows.find((r) => r.userId === userId && r.id === id && r.expiresAt > at) ?? null; const changed = Boolean(row && !row.deletedAt); if (row && changed) row.deletedAt = at; return row ? { row, changed } : null; }
  async getPreferences(userId: string) { return Object.entries(Object.fromEntries(this.preferences)).filter(([key]) => key.startsWith(`${userId}:`)).map(([key, enabled]) => ({ category: key.slice(userId.length + 1) as NotificationCategory, enabled })); }
  async upsertPreferences(userId: string, values: Partial<Record<NotificationCategory, boolean>>) { for (const [category, enabled] of Object.entries(values)) this.preferences.set(`${userId}:${category}`, Boolean(enabled)); return this.getPreferences(userId); }
  async findByDedupeKey(key: string) { return this.rows.find((row) => row.dedupeKey === key) ?? null; }
  async findCurrentAggregate(key: string) { return this.rows.find((row) => row.aggregationKey === key && !row.deletedAt) ?? null; }
  async create(input: Omit<StoredNotification, "id" | "updatedAt">) { const row = active(`n-${this.rows.length + 1}`, { ...input, updatedAt: input.createdAt }); this.rows.push(row); return row; }
  async persistAggregate(input: Omit<StoredNotification, "id" | "updatedAt"> & { aggregationKey: string }) { const row = this.rows.find((item) => item.userId === input.userId && item.aggregationKey === input.aggregationKey && !item.deletedAt); if (input.dedupeKey && !this.outboxEvents.has(input.dedupeKey)) throw Object.assign(new Error("outbox missing"), { code: "NOTIFICATION_EVENT_NOT_FOUND" }); if (input.dedupeKey && this.outboxEvents.get(input.dedupeKey) === "PROCESSED") return { row: row!, changed: false }; if (row) { const next = input.type === NotificationType.SAVED_SEARCH_MATCHES ? { ...input, metadata: mergeSavedSearchAggregate(row.metadata, input.metadata) } : input; if (next.type === NotificationType.SAVED_SEARCH_MATCHES) next.body = `وجدنا ${next.metadata.totalCount} نتيجة جديدة`; Object.assign(row, { ...next, dedupeKey: row.dedupeKey, readAt: null }); return { row, changed: true }; } return { row: await this.create(input), changed: true }; }
  async updateAggregate(id: string, input: Partial<Pick<StoredNotification, "title" | "body" | "actionUrl" | "metadata" | "expiresAt" | "updatedAt">>) { const row = this.rows.find((item) => item.id === id)!; Object.assign(row, input, { readAt: null }); return row; }
}

const payload = { eventType: NotificationType.LISTING_APPROVED, recipientId: "user-a", listingId: "listing-1", listingTitle: "Bike" } as const;

describe("NotificationsService", () => {
  it("lists active, user-scoped rows using newest cursor order and filters", async () => {
    const repo = new MemoryRepo();
    repo.rows = [active("a", { createdAt: new Date("2026-08-24T11:00:00.000Z") }), active("b", { createdAt: new Date("2026-08-24T11:00:00.000Z"), category: NotificationCategory.MESSAGES }), active("expired", { expiresAt: new Date("2026-08-24T11:59:59.000Z") }), active("deleted", { deletedAt: now }), active("other", { userId: "user-b" })];
    const service = new NotificationsService(repo, { now: () => now });
    const listed = await service.list("user-a", { limit: 50, unread: true });
    expect(listed.items.map((row) => row.id)).toEqual(["b", "a"]);
    expect(listed.items.every((row) => row.createdAt.endsWith("Z"))).toBe(true);
  });

  it("caps pages at 50 and applies category, read state, and opaque cursor ordering", async () => {
    const repo = new MemoryRepo();
    repo.rows = Array.from({ length: 52 }, (_, index) => active(`n-${String(index).padStart(2, "0")}`, { createdAt: new Date(now.getTime() - index * 1_000), category: index === 0 ? NotificationCategory.MESSAGES : NotificationCategory.LISTINGS, readAt: index === 1 ? now : null }));
    const service = new NotificationsService(repo, { now: () => now });
    const first = await service.list("user-a", { limit: 99 });
    expect(first.items).toHaveLength(50); expect(first.hasMore).toBe(true); expect(first.nextCursor).toBeTruthy();
    expect(decodeNotificationCursor(first.nextCursor!)).toEqual({ createdAt: new Date(now.getTime() - 49_000).toISOString(), id: "n-49" });
    await expect(service.list("user-a", { limit: 50, cursor: first.nextCursor! })).resolves.toMatchObject({ items: [{ id: "n-50" }, { id: "n-51" }], hasMore: false });
    await expect(service.list("user-a", { limit: 50, category: NotificationCategory.MESSAGES, unread: true })).resolves.toMatchObject({ items: [{ id: "n-00" }] });
    await expect(service.list("user-a", { limit: 50, unread: false })).resolves.toMatchObject({ items: [{ id: "n-01" }] });
  });

  it("uses Task 2 opaque cursors and rejects malformed or extra cursor fields", () => {
    const encoded = encodeNotificationCursor({ createdAt: "2026-08-24T11:59:11.000Z", id: "n-49" });
    expect(decodeNotificationCursor(encoded)).toEqual({ createdAt: "2026-08-24T11:59:11.000Z", id: "n-49" });
    const extraField = Buffer.from(JSON.stringify({ createdAt: "2026-08-24T11:59:11.000Z", id: "n-49", userId: "must-not-be-accepted" }), "utf8").toString("base64url");
    expect(() => decodeNotificationCursor("not-base64")).toThrow("Invalid notification cursor");
    expect(() => decodeNotificationCursor(extraField)).toThrow("Invalid notification cursor");
  });

  it("counts only active unread rows", async () => {
    const repo = new MemoryRepo(); repo.rows = [active("unread"), active("read", { readAt: now }), active("expired", { expiresAt: new Date(0) }), active("deleted", { deletedAt: now })];
    await expect(new NotificationsService(repo, { now: () => now }).unreadCount("user-a")).resolves.toBe(1);
  });

  it("does not reveal cross-user rows and makes repeated mutations idempotent", async () => {
    const repo = new MemoryRepo(); repo.rows = [active("owned"), active("other", { userId: "user-b" })]; const service = new NotificationsService(repo, { now: () => now });
    await expect(service.markRead("user-a", "other")).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    await service.markRead("user-a", "owned"); await expect(service.markRead("user-a", "owned")).resolves.toMatchObject({ id: "owned" });
    await expect(service.delete("user-a", "other")).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    await service.delete("user-a", "owned"); await expect(service.delete("user-a", "owned")).resolves.toMatchObject({ id: "owned" });
  });

  it("resolves preferences with optional defaults and locked mandatory categories", async () => {
    const repo = new MemoryRepo(); repo.preferences.set("user-a:LISTINGS", false); const service = new NotificationsService(repo, { now: () => now });
    await expect(service.getPreferences("user-a")).resolves.toEqual({ MESSAGES: true, LISTINGS: false, ENGAGEMENT: true, SAVED_SEARCHES: true, SYSTEM: true, SECURITY: true });
    await expect(service.createFromEvent(NotificationType.LISTING_APPROVED, payload)).resolves.toBeNull();
    await expect(service.createFromEvent(NotificationType.SECURITY_ALERT, { eventType: NotificationType.SECURITY_ALERT, recipientId: "user-a", alertId: "security-1" })).resolves.toMatchObject({ category: "SECURITY" });
  });

  it("uses dedupe, a precise 90-day expiry, and signals only after persistence", async () => {
    const repo = new MemoryRepo(); const signals: Array<[string, string, number]> = []; const service = new NotificationsService(repo, { now: () => now, publishSignal: async (userId: string, notificationId: string, unreadCount: number) => { signals.push([userId, notificationId, unreadCount]); } });
    const first = await service.createFromEvent(NotificationType.LISTING_APPROVED, payload, { dedupeKey: "event-1" });
    const second = await service.createFromEvent(NotificationType.LISTING_APPROVED, payload, { dedupeKey: "event-1" });
    expect(repo.rows[0].expiresAt.toISOString()).toBe("2026-11-22T12:00:00.000Z"); expect(second!.id).toBe(first!.id); expect(repo.rows).toHaveLength(1); expect(signals).toEqual([["user-a", first!.id, 1]]);
  });

  it("refetches a concurrent dedupe conflict without duplicating or publishing", async () => {
    const repo = new MemoryRepo(); const existing = active("existing", { dedupeKey: "event-race" });
    let lookups = 0;
    jest.spyOn(repo, "findByDedupeKey").mockImplementation(async () => (++lookups > 1 ? existing : null));
    jest.spyOn(repo, "create").mockRejectedValue(Object.assign(new Error("duplicate"), { code: "P2002" }));
    const publishSignal = jest.fn(); const service = new NotificationsService(repo, { now: () => now, publishSignal });
    await expect(service.createFromEvent(NotificationType.LISTING_APPROVED, payload, { dedupeKey: "event-race" })).resolves.toMatchObject({ id: "existing" });
    expect(publishSignal).not.toHaveBeenCalled();
  });

  it("reopens a read aggregate when fresh aggregate activity is persisted", async () => {
    const repo = new MemoryRepo(); repo.rows = [active("aggregate", { aggregationKey: "listing-1:hour", readAt: now })];
    const service = new NotificationsService(repo, { now: () => now });
    await service.createFromEvent(NotificationType.LISTING_APPROVED, payload, { aggregationKey: "listing-1:hour" });
    expect(repo.rows[0].readAt).toBeNull();
  });

  it("keeps concurrent same-key aggregate creates to one current row", async () => {
    const repo = new MemoryRepo(); const service = new NotificationsService(repo, { now: () => now });
    await Promise.all([
      service.createFromEvent(NotificationType.LISTING_APPROVED, payload, { aggregationKey: "listing-1:hour" }),
      service.createFromEvent(NotificationType.LISTING_APPROVED, payload, { aggregationKey: "listing-1:hour" }),
    ]);
    expect(repo.rows.filter((row) => row.aggregationKey === "listing-1:hour")).toHaveLength(1);
  });

  it("deduplicates aggregate events durably across A, B, replay B, and concurrent B", async () => {
    const repo = new MemoryRepo(); const publishSignal = jest.fn(); const service = new NotificationsService(repo, { now: () => now, publishSignal });
    repo.outboxEvents.set("A", "PENDING"); repo.outboxEvents.set("B", "PENDING");
    await service.createFromEvent(NotificationType.LISTING_APPROVED, payload, { aggregationKey: "listing-1:hour", dedupeKey: "A" });
    await service.createFromEvent(NotificationType.LISTING_APPROVED, payload, { aggregationKey: "listing-1:hour", dedupeKey: "B" });
    repo.outboxEvents.set("B", "PROCESSED");
    await service.createFromEvent(NotificationType.LISTING_APPROVED, payload, { aggregationKey: "listing-1:hour", dedupeKey: "B" });
    await Promise.all([service.createFromEvent(NotificationType.LISTING_APPROVED, payload, { aggregationKey: "listing-1:hour", dedupeKey: "B" }), service.createFromEvent(NotificationType.LISTING_APPROVED, payload, { aggregationKey: "listing-1:hour", dedupeKey: "B" })]);
    expect(repo.rows).toHaveLength(1); expect(repo.rows[0].metadata).not.toHaveProperty("processedDedupeKeys"); expect(publishSignal).toHaveBeenCalledTimes(2);
  });

  it("does not publish a signal for idempotent read, delete, or read-all no-ops", async () => {
    const repo = new MemoryRepo(); repo.rows = [active("read", { readAt: now }), active("deleted", { deletedAt: now })];
    const publishSignal = jest.fn(); const service = new NotificationsService(repo, { now: () => now, publishSignal });
    await service.markRead("user-a", "read"); await service.delete("user-a", "deleted"); await service.markAllRead("user-a");
    expect(publishSignal).not.toHaveBeenCalled();
  });

  it("retains favorite freshness metadata internally but omits it from API DTOs", async () => {
    const repo = new MemoryRepo();
    const service = new NotificationsService(repo, { now: () => now });
    const result = await service.createFromEvent(NotificationType.LISTING_FAVORITED_AGGREGATE, {
      eventType: NotificationType.LISTING_FAVORITED_AGGREGATE,
      recipientId: "user-a",
      listingId: "listing-1",
      listingTitle: "Bike",
      favoriteCount: 3,
      sourceTimestamp: "2026-08-24T11:55:00.000Z",
      sourceId: "favorite-cycle-1",
      sourceVersion: "41",
    });

    expect(repo.rows[0].metadata).toMatchObject({ sourceTimestamp: "2026-08-24T11:55:00.000Z", sourceId: "favorite-cycle-1", sourceVersion: "41" });
    expect(result?.metadata).toEqual({ listingId: "listing-1", favoriteCount: 3 });
  });

  it("merges saved-search matches hourly, caps listed ids at ten, and retains the exact total", async () => {
    const repo = new MemoryRepo();
    const service = new NotificationsService(repo, { now: () => now });
    const key = "saved-search:user-a:search-1:2026-08-24T12";
    for (let index = 1; index <= 12; index += 1) {
      repo.outboxEvents.set(`match-${index}`, "PENDING");
      await service.createFromEvent(NotificationType.SAVED_SEARCH_MATCHES, {
        eventType: NotificationType.SAVED_SEARCH_MATCHES,
        recipientId: "user-a",
        savedSearchId: "search-1",
        savedSearchName: "Laptops",
        query: { city: "Amman" },
        matchingListingIds: [`listing-${index}`],
        totalCount: 1,
      }, { aggregationKey: key, dedupeKey: `match-${index}` });
    }
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].metadata.totalCount).toBe(12);
    expect(repo.rows[0].metadata.matchingListingIds).toEqual(Array.from({ length: 10 }, (_, index) => `listing-${index + 1}`));
    expect(repo.rows[0].body).toContain("12");
  });
});
