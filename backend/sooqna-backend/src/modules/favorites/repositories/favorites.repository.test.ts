import type { FavoriteRecord } from "../favorites.types";

const mockQueryRaw = jest.fn();
const mockFavorite = {
  findMany: jest.fn(),
  findUnique: jest.fn(),
  upsert: jest.fn(),
  deleteMany: jest.fn(),
  count: jest.fn(),
};
let storedRecords: FavoriteRecord[] = [];

jest.mock("../../../config/env", () => ({
  env: { enableCategoriesJsonFallback: true },
}));
jest.mock("../../../config/prisma", () => ({
  prisma: { $queryRaw: mockQueryRaw, favorite: mockFavorite },
}));
jest.mock("../../../utils/fileStore", () => ({
  readJsonArrayFile: jest.fn(() => storedRecords.map((record) => ({ ...record }))),
  writeJsonArrayFile: jest.fn((_path: string, records: FavoriteRecord[]) => {
    storedRecords = records.map((record) => ({ ...record }));
  }),
}));

describe("PrismaFavoritesRepository upsert", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storedRecords = [];
  });

  it("uses one atomic database statement and reports whether the favorite was created", async () => {
    const { PrismaFavoritesRepository } = await import("./favorites.repository");
    mockQueryRaw.mockResolvedValue([{ created: true }]);
    const repo = new PrismaFavoritesRepository();

    await expect(repo.upsert({ userId: "user-1", listingId: "listing-1", createdAt: "2026-08-24T15:42:00.000Z" }))
      .resolves.toEqual({ created: true });

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(mockFavorite.findUnique).not.toHaveBeenCalled();
    expect(mockFavorite.upsert).not.toHaveBeenCalled();
  });

  it("reports created only for the first JSON-fallback favorite", async () => {
    const { PrismaFavoritesRepository } = await import("./favorites.repository");
    mockQueryRaw.mockRejectedValue(new Error("database offline"));
    const repo = new PrismaFavoritesRepository();
    const favorite = { userId: "user-1", listingId: "listing-1", createdAt: "2026-08-24T15:42:00.000Z" };

    await expect(repo.upsert(favorite)).resolves.toEqual({ created: true });
    await expect(repo.upsert(favorite)).resolves.toEqual({ created: false });
    expect(storedRecords).toEqual([favorite]);
  });
});
