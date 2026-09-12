const mockExecuteRaw = jest.fn();
const mockFindUnique = jest.fn();
const mockCreate = jest.fn();
const mockCount = jest.fn();
const mockDeleteMany = jest.fn();
const mockListingUpdateMany = jest.fn();
const mockTransaction = jest.fn();
const mockReadFavorites = jest.fn();
const mockWriteFavorites = jest.fn();
const mockWithFileLock = jest.fn();
const mockEnv = { enableCategoriesJsonFallback: false };

const transactionClient = {
  $executeRaw: mockExecuteRaw,
  favorite: { findUnique: mockFindUnique, create: mockCreate, count: mockCount, deleteMany: mockDeleteMany },
  listing: { updateMany: mockListingUpdateMany },
};

jest.mock("../../../config/prisma", () => ({ prisma: { $transaction: mockTransaction } }));
jest.mock("../../../config/env", () => ({ env: mockEnv }));
jest.mock("../../../utils/fileStore", () => ({
  readJsonArrayFile: mockReadFavorites,
  writeJsonArrayFileAtomically: mockWriteFavorites,
}));
jest.mock("../../../shared/database/fileLock", () => ({ withFileLock: mockWithFileLock }));

import { PrismaFavoritesRepository } from "./favorites.repository";

describe("PrismaFavoritesRepository favorite mutation snapshots", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnv.enableCategoriesJsonFallback = false;
    mockTransaction.mockImplementation(async (work: (tx: typeof transactionClient) => unknown) => work(transactionClient));
    mockWithFileLock.mockImplementation(async (_path: string, work: () => unknown) => work());
    mockExecuteRaw.mockResolvedValue(1);
    mockListingUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("locks the listing and returns creation identity, monotonic version, and count from one transaction", async () => {
    mockFindUnique.mockResolvedValue(null);
    mockCreate.mockResolvedValue({
      id: "favorite-cycle-1",
      createdAt: new Date("2026-08-24T15:42:00.000Z"),
      notificationVersion: 41n,
    });
    mockCount.mockResolvedValue(4);

    const result = await new PrismaFavoritesRepository().upsert({ userId: "actor-1", listingId: "listing-1", createdAt: "2026-08-24T15:42:00.000Z" });

    expect(result).toEqual({ created: true, sourceId: "favorite-cycle-1", sourceTimestamp: "2026-08-24T15:42:00.000Z", sourceVersion: "41", favoriteCount: 4 });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw.mock.invocationCallOrder[0]).toBeLessThan(mockCreate.mock.invocationCallOrder[0]);
    expect(mockCreate.mock.invocationCallOrder[0]).toBeLessThan(mockCount.mock.invocationCallOrder[0]);
    expect(mockCount.mock.invocationCallOrder[0]).toBeLessThan(mockListingUpdateMany.mock.invocationCallOrder[0]);
    expect(mockListingUpdateMany).toHaveBeenCalledWith({ where: { id: "listing-1", deletedAt: null }, data: { favoritesCount: 4 } });
  });

  it("reports a duplicate without creating a second cycle and returns the locked count", async () => {
    mockFindUnique.mockResolvedValue({ id: "favorite-cycle-1" });
    mockCount.mockResolvedValue(4);

    const result = await new PrismaFavoritesRepository().upsert({ userId: "actor-1", listingId: "listing-1", createdAt: "2026-08-24T15:42:00.000Z" });

    expect(result).toEqual({ created: false, favoriteCount: 4 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("serializes removal, count, and listing counter update under the same listing lock", async () => {
    mockDeleteMany.mockResolvedValue({ count: 1 });
    mockCount.mockResolvedValue(3);

    const result = await new PrismaFavoritesRepository().remove("actor-1", "listing-1");

    expect(result).toEqual({ removed: true, favoriteCount: 3 });
    expect(mockExecuteRaw.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteMany.mock.invocationCallOrder[0]);
    expect(mockDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(mockCount.mock.invocationCallOrder[0]);
    expect(mockListingUpdateMany).toHaveBeenCalledWith({ where: { id: "listing-1", deletedAt: null }, data: { favoritesCount: 3 } });
  });

  it("persists increasing cycle versions and counts under one JSON file lock", async () => {
    mockEnv.enableCategoriesJsonFallback = true;
    mockTransaction.mockRejectedValue(new Error("database unavailable"));
    let stored: Array<Record<string, unknown>> = [];
    mockReadFavorites.mockImplementation(() => stored);
    mockWriteFavorites.mockImplementation((_path: string, rows: Array<Record<string, unknown>>) => { stored = rows; });
    const repository = new PrismaFavoritesRepository();

    const first = await repository.upsert({ userId: "actor-1", listingId: "listing-1", createdAt: "2026-08-24T15:42:00.000Z" });
    const duplicate = await repository.upsert({ userId: "actor-1", listingId: "listing-1", createdAt: "2026-08-24T15:42:00.000Z" });
    await repository.remove("actor-1", "listing-1");
    const second = await repository.upsert({ userId: "actor-1", listingId: "listing-1", createdAt: "2026-08-24T15:42:00.000Z" });

    expect(first).toMatchObject({ created: true, sourceVersion: "1", favoriteCount: 1 });
    expect(duplicate).toEqual({ created: false, favoriteCount: 1 });
    expect(second).toMatchObject({ created: true, sourceVersion: "2", favoriteCount: 1 });
    expect(mockWithFileLock).toHaveBeenCalledTimes(4);
  });
});
