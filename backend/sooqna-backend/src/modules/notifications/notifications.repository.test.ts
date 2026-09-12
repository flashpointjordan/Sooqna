import { NotificationCategory, NotificationType } from "@prisma/client";

const mockPreferenceUpsert = jest.fn();
const mockExecuteRaw = jest.fn();
const mockNotificationFindFirst = jest.fn();
const mockNotificationUpdate = jest.fn();
const mockNotificationCreate = jest.fn();
const mockTransaction = jest.fn();
const mockOutboxFindUnique = jest.fn(); const mockOutboxCreate = jest.fn(); const mockOutboxUpdate = jest.fn();
const mockPrisma = {
  notificationPreference: { findMany: jest.fn(), upsert: jest.fn() },
  notification: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  $transaction: mockTransaction,
};

jest.mock("../../config/prisma", () => ({ prisma: mockPrisma }));
jest.mock("../../config/env", () => ({
  env: { enableCategoriesJsonFallback: false, databaseUrl: "postgresql://test" },
}));

import { JsonNotificationsRepository, PrismaNotificationsRepository, type JsonNotificationsStore } from "./notifications.repository";

const row = {
  id: "aggregate", userId: "user-a", type: NotificationType.LISTING_FAVORITED_AGGREGATE, category: NotificationCategory.ENGAGEMENT,
  title: "old", body: "old", actionUrl: "/listings/listing-1", entityType: "listing", entityId: "listing-1", metadata: { listingId: "listing-1" }, dedupeKey: null, aggregationKey: "listing-1:hour", readAt: new Date("2026-08-24T11:00:00.000Z"), deletedAt: null,
  expiresAt: new Date("2026-11-22T12:00:00.000Z"), createdAt: new Date("2026-08-24T10:00:00.000Z"), updatedAt: new Date("2026-08-24T10:00:00.000Z"),
};

describe("PrismaNotificationsRepository persistence guarantees", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      $executeRaw: mockExecuteRaw,
      notificationPreference: { upsert: mockPreferenceUpsert },
      notification: { findFirst: mockNotificationFindFirst, update: mockNotificationUpdate, create: mockNotificationCreate },
      notificationOutbox: { findUnique: mockOutboxFindUnique, create: mockOutboxCreate, update: mockOutboxUpdate },
    }));
  });

  it("uses one transaction for a preference batch and aborts when an upsert fails", async () => {
    mockPreferenceUpsert.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("write failed"));
    await expect(new PrismaNotificationsRepository().upsertPreferences("user-a", { MESSAGES: false, LISTINGS: true })).rejects.toThrow("write failed");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockPreferenceUpsert).toHaveBeenCalledTimes(2);
    expect(mockPrisma.notificationPreference.findMany).not.toHaveBeenCalled();
  });

  it("serializes same-key aggregate persistence in a database transaction and reopens the row", async () => {
    mockNotificationFindFirst.mockResolvedValue(row); mockNotificationUpdate.mockResolvedValue({ ...row, readAt: null, title: "new" }); mockOutboxFindUnique.mockResolvedValue({ state: "PENDING" }); mockOutboxUpdate.mockResolvedValue({});
    const result = await new PrismaNotificationsRepository().persistAggregate({ userId: row.userId, type: row.type, category: row.category, title: "new", body: row.body, actionUrl: row.actionUrl, entityType: row.entityType, entityId: row.entityId, metadata: row.metadata, dedupeKey: row.dedupeKey, aggregationKey: "listing-1:hour", readAt: null, deletedAt: null, expiresAt: row.expiresAt, createdAt: row.createdAt });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(mockNotificationUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ readAt: null, title: "new" }) }));
    expect(mockNotificationUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ metadata: row.metadata }) }));
    expect(mockOutboxUpdate).not.toHaveBeenCalled();
    expect(result).not.toBeNull(); expect(result!.row.readAt).toBeNull();
  });

  it("rejects aggregate persistence without the producer-created outbox event", async () => {
    mockNotificationFindFirst.mockResolvedValue(row); mockOutboxFindUnique.mockResolvedValue(null);
    await expect(new PrismaNotificationsRepository().persistAggregate({ userId: row.userId, type: row.type, category: row.category, title: row.title, body: row.body, actionUrl: row.actionUrl, entityType: row.entityType, entityId: row.entityId, metadata: row.metadata, dedupeKey: "missing", aggregationKey: "listing-1:hour", readAt: null, deletedAt: null, expiresAt: row.expiresAt, createdAt: row.createdAt })).rejects.toMatchObject({ code: "NOTIFICATION_EVENT_NOT_FOUND" });
    expect(mockNotificationUpdate).not.toHaveBeenCalled(); expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("uses the internal processed outbox ledger to make old aggregate replays no-ops", async () => {
    mockNotificationFindFirst.mockResolvedValue(row); mockOutboxFindUnique.mockResolvedValue({ state: "PROCESSED" });
    const result = await new PrismaNotificationsRepository().persistAggregate({ userId: row.userId, type: row.type, category: row.category, title: row.title, body: row.body, actionUrl: row.actionUrl, entityType: row.entityType, entityId: row.entityId, metadata: row.metadata, dedupeKey: "event-old", aggregationKey: "listing-1:hour", readAt: null, deletedAt: null, expiresAt: row.expiresAt, createdAt: row.createdAt });
    expect(result).toMatchObject({ changed: false }); expect(mockNotificationUpdate).not.toHaveBeenCalled(); expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("does not resurrect a deleted aggregate for a processed event", async () => {
    mockNotificationFindFirst.mockResolvedValue(null); mockOutboxFindUnique.mockResolvedValue({ state: "PROCESSED" });
    await expect(new PrismaNotificationsRepository().persistAggregate({ userId: row.userId, type: row.type, category: row.category, title: row.title, body: row.body, actionUrl: row.actionUrl, entityType: row.entityType, entityId: row.entityId, metadata: row.metadata, dedupeKey: "processed-deleted", aggregationKey: "listing-1:hour", readAt: null, deletedAt: null, expiresAt: row.expiresAt, createdAt: row.createdAt })).resolves.toBeNull();
    expect(mockNotificationCreate).not.toHaveBeenCalled(); expect(mockNotificationUpdate).not.toHaveBeenCalled();
  });

  it.each(["FAILED", "DEAD"])("does not apply aggregates for %s outbox events", async (state) => {
    mockNotificationFindFirst.mockResolvedValue(row); mockOutboxFindUnique.mockResolvedValue({ state });
    await expect(new PrismaNotificationsRepository().persistAggregate({ userId: row.userId, type: row.type, category: row.category, title: row.title, body: row.body, actionUrl: row.actionUrl, entityType: row.entityType, entityId: row.entityId, metadata: row.metadata, dedupeKey: `event-${state}`, aggregationKey: "listing-1:hour", readAt: null, deletedAt: null, expiresAt: row.expiresAt, createdAt: row.createdAt })).resolves.toBeNull();
    expect(mockNotificationCreate).not.toHaveBeenCalled(); expect(mockNotificationUpdate).not.toHaveBeenCalled();
  });

  it("does not let an older favorite aggregate overwrite a newer persisted count", async () => {
    const newer = { ...row, metadata: { listingId: "listing-1", favoriteCount: 9, sourceTimestamp: "2026-08-24T15:55:00.000Z" } };
    mockNotificationFindFirst.mockResolvedValue(newer);
    mockOutboxFindUnique.mockResolvedValue({ state: "PROCESSING" });

    const result = await new PrismaNotificationsRepository().persistAggregate({
      userId: row.userId,
      type: row.type,
      category: row.category,
      title: "older",
      body: "older",
      actionUrl: row.actionUrl,
      entityType: row.entityType,
      entityId: row.entityId,
      metadata: { listingId: "listing-1", favoriteCount: 2, sourceTimestamp: "2026-08-24T15:40:00.000Z" },
      dedupeKey: "favorite-cycle-old",
      aggregationKey: "listing-1:hour",
      readAt: null,
      deletedAt: null,
      expiresAt: row.expiresAt,
      createdAt: new Date("2026-08-24T16:05:00.000Z"),
    });

    expect(result).toMatchObject({ row: expect.objectContaining({ metadata: newer.metadata }), changed: false });
    expect(mockNotificationUpdate).not.toHaveBeenCalled();
  });

  it("applies the same favorite freshness guard in the JSON repository", async () => {
    const newer = { ...row, metadata: { listingId: "listing-1", favoriteCount: 9, sourceTimestamp: "2026-08-24T15:55:00.000Z" } };
    const state = { notifications: [newer], preferences: [] };
    const store = {
      readNotificationState: jest.fn(async () => state),
      mutateNotificationState: jest.fn(async (work: (value: typeof state) => unknown) => work(state)),
    } as unknown as JsonNotificationsStore;

    const result = await new JsonNotificationsRepository(store).persistAggregate({
      userId: row.userId,
      type: row.type,
      category: row.category,
      title: "older",
      body: "older",
      actionUrl: row.actionUrl,
      entityType: row.entityType,
      entityId: row.entityId,
      metadata: { listingId: "listing-1", favoriteCount: 2, sourceTimestamp: "2026-08-24T15:40:00.000Z" },
      dedupeKey: "favorite-cycle-old",
      aggregationKey: "listing-1:hour",
      readAt: null,
      deletedAt: null,
      expiresAt: row.expiresAt,
      createdAt: new Date("2026-08-24T16:05:00.000Z"),
    });

    expect(result).toMatchObject({ row: expect.objectContaining({ metadata: newer.metadata }), changed: false });
    expect(state.notifications[0].metadata).toEqual(newer.metadata);
  });

  it("lets a newer favorite aggregate replace an older JSON count", async () => {
    const older = { ...row, metadata: { listingId: "listing-1", favoriteCount: 2, sourceTimestamp: "2026-08-24T15:40:00.000Z" } };
    const state = { notifications: [older], preferences: [] };
    const store = {
      readNotificationState: jest.fn(async () => state),
      mutateNotificationState: jest.fn(async (work: (value: typeof state) => unknown) => work(state)),
    } as unknown as JsonNotificationsStore;

    const result = await new JsonNotificationsRepository(store).persistAggregate({
      userId: row.userId,
      type: row.type,
      category: row.category,
      title: "newer",
      body: "newer",
      actionUrl: row.actionUrl,
      entityType: row.entityType,
      entityId: row.entityId,
      metadata: { listingId: "listing-1", favoriteCount: 9, sourceTimestamp: "2026-08-24T15:55:00.000Z" },
      dedupeKey: "favorite-cycle-new",
      aggregationKey: "listing-1:hour",
      readAt: null,
      deletedAt: null,
      expiresAt: row.expiresAt,
      createdAt: new Date("2026-08-24T16:00:00.000Z"),
    });

    expect(result).toMatchObject({ changed: true, row: expect.objectContaining({ title: "newer", metadata: expect.objectContaining({ favoriteCount: 9 }) }) });
  });

  it("orders equal-timestamp Prisma favorite events by their atomic source version", async () => {
    const current = { ...row, metadata: { listingId: "listing-1", favoriteCount: 9, sourceTimestamp: "2026-08-24T15:55:00.000Z", sourceId: "favorite-cycle-old", sourceVersion: "41" } };
    mockNotificationFindFirst.mockResolvedValue(current);
    mockOutboxFindUnique.mockResolvedValue({ state: "PROCESSING" });
    mockNotificationUpdate.mockResolvedValue({ ...current, title: "newer create", metadata: { ...current.metadata, favoriteCount: 2, sourceId: "favorite-cycle-new", sourceVersion: "42" } });

    const result = await new PrismaNotificationsRepository().persistAggregate({
      userId: row.userId, type: row.type, category: row.category,
      title: "newer create", body: "newer create",
      actionUrl: row.actionUrl, entityType: row.entityType, entityId: row.entityId,
      metadata: { listingId: "listing-1", favoriteCount: 2, sourceTimestamp: "2026-08-24T15:55:00.000Z", sourceId: "favorite-cycle-new", sourceVersion: "42" },
      dedupeKey: "favorite-cycle-new", aggregationKey: "listing-1:hour",
      readAt: null, deletedAt: null, expiresAt: row.expiresAt,
      createdAt: new Date("2026-08-24T16:05:00.000Z"),
    });

    expect(result).toMatchObject({ changed: true, row: expect.objectContaining({ metadata: expect.objectContaining({ favoriteCount: 2, sourceId: "favorite-cycle-new", sourceVersion: "42" }) }) });
    expect(mockNotificationUpdate).toHaveBeenCalledTimes(1);
  });

  it("orders equal-timestamp JSON favorite events by their atomic source version", async () => {
    const current = { ...row, metadata: { listingId: "listing-1", favoriteCount: 2, sourceTimestamp: "2026-08-24T15:55:00.000Z", sourceId: "favorite-cycle-old", sourceVersion: "41" } };
    const state = { notifications: [current], preferences: [] };
    const store = {
      readNotificationState: jest.fn(async () => state),
      mutateNotificationState: jest.fn(async (work: (value: typeof state) => unknown) => work(state)),
    } as unknown as JsonNotificationsStore;

    const result = await new JsonNotificationsRepository(store).persistAggregate({
      userId: row.userId, type: row.type, category: row.category,
      title: "newer create", body: "newer create",
      actionUrl: row.actionUrl, entityType: row.entityType, entityId: row.entityId,
      metadata: { listingId: "listing-1", favoriteCount: 3, sourceTimestamp: "2026-08-24T15:55:00.000Z", sourceId: "favorite-cycle-new", sourceVersion: "42" },
      dedupeKey: "favorite-cycle-new", aggregationKey: "listing-1:hour",
      readAt: null, deletedAt: null, expiresAt: row.expiresAt,
      createdAt: new Date("2026-08-24T16:05:00.000Z"),
    });

    expect(result).toMatchObject({ changed: true, row: expect.objectContaining({ metadata: expect.objectContaining({ favoriteCount: 3, sourceId: "favorite-cycle-new", sourceVersion: "42" }) }) });
  });
});
