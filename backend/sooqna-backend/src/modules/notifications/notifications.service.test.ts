import { NotificationCategory, NotificationType } from "@prisma/client";
import { NotificationsService, type NotificationsRepository, type StoredNotification } from "./notifications.service";

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
  async listActive(userId: string, query: { limit: number; cursor?: string; category?: NotificationCategory; unread?: boolean }, at: Date) {
    let rows = this.rows.filter((row) => row.userId === userId && !row.deletedAt && row.expiresAt > at && (!query.category || row.category === query.category) && (query.unread === undefined || (query.unread ? !row.readAt : !!row.readAt)));
    rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    if (query.cursor) { const [time, id] = query.cursor.split("|"); rows = rows.filter((row) => row.createdAt < new Date(time) || (row.createdAt.getTime() === new Date(time).getTime() && row.id < id)); }
    const page = rows.slice(0, Math.min(query.limit, 50));
    return { items: page, hasMore: rows.length > page.length, nextCursor: page.length && rows.length > page.length ? `${page.at(-1)!.createdAt.toISOString()}|${page.at(-1)!.id}` : null };
  }
  async countUnread(userId: string, at: Date) { return this.rows.filter((r) => r.userId === userId && !r.deletedAt && r.expiresAt > at && !r.readAt).length; }
  async findActiveOwned(userId: string, id: string, at: Date) { return this.rows.find((r) => r.userId === userId && r.id === id && !r.deletedAt && r.expiresAt > at) ?? null; }
  async markReadOwned(userId: string, id: string, at: Date) { const row = await this.findActiveOwned(userId, id, at); if (row && !row.readAt) row.readAt = at; return row; }
  async markAllRead(userId: string, at: Date) { let count = 0; for (const row of this.rows) if (row.userId === userId && !row.deletedAt && row.expiresAt > at && !row.readAt) { row.readAt = at; count++; } return count; }
  async softDeleteOwned(userId: string, id: string, at: Date) { const row = this.rows.find((r) => r.userId === userId && r.id === id && r.expiresAt > at) ?? null; if (row) row.deletedAt ??= at; return row; }
  async getPreferences(userId: string) { return Object.entries(Object.fromEntries(this.preferences)).filter(([key]) => key.startsWith(`${userId}:`)).map(([key, enabled]) => ({ category: key.slice(userId.length + 1) as NotificationCategory, enabled })); }
  async upsertPreferences(userId: string, values: Partial<Record<NotificationCategory, boolean>>) { for (const [category, enabled] of Object.entries(values)) this.preferences.set(`${userId}:${category}`, Boolean(enabled)); return this.getPreferences(userId); }
  async findByDedupeKey(key: string) { return this.rows.find((row) => row.dedupeKey === key) ?? null; }
  async findCurrentAggregate(key: string) { return this.rows.find((row) => row.aggregationKey === key && !row.deletedAt) ?? null; }
  async create(input: Omit<StoredNotification, "id" | "updatedAt">) { const row = active(`n-${this.rows.length + 1}`, { ...input, updatedAt: input.createdAt }); this.rows.push(row); return row; }
  async updateAggregate(id: string, input: Partial<Pick<StoredNotification, "title" | "body" | "actionUrl" | "metadata" | "expiresAt" | "updatedAt">>) { const row = this.rows.find((item) => item.id === id)!; Object.assign(row, input); return row; }
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
    await expect(service.list("user-a", { limit: 50, cursor: first.nextCursor! })).resolves.toMatchObject({ items: [{ id: "n-50" }, { id: "n-51" }], hasMore: false });
    await expect(service.list("user-a", { limit: 50, category: NotificationCategory.MESSAGES, unread: true })).resolves.toMatchObject({ items: [{ id: "n-00" }] });
    await expect(service.list("user-a", { limit: 50, unread: false })).resolves.toMatchObject({ items: [{ id: "n-01" }] });
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
});
