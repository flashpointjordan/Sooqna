const mockCreate = jest.fn();
const mockReadFavorites = jest.fn();
const mockWriteFavorites = jest.fn();
const mockEnv = { enableCategoriesJsonFallback: false };

jest.mock("../../../config/prisma", () => ({
  prisma: {
    favorite: {
      create: mockCreate,
    },
  },
}));
jest.mock("../../../config/env", () => ({
  env: mockEnv,
}));
jest.mock("../../../utils/fileStore", () => ({
  readJsonArrayFile: mockReadFavorites,
  writeJsonArrayFile: mockWriteFavorites,
}));

import { PrismaFavoritesRepository } from "./favorites.repository";

describe("PrismaFavoritesRepository.upsert", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnv.enableCategoriesJsonFallback = false;
  });

  it("reports a newly inserted favorite", async () => {
    mockCreate.mockResolvedValue({
      id: "favorite-cycle-1",
      createdAt: new Date("2026-08-24T15:42:00.000Z"),
    });

    const result = await new PrismaFavoritesRepository().upsert({
      userId: "actor-1",
      listingId: "listing-1",
      createdAt: "2026-08-24T15:42:00.000Z",
    });

    expect(result).toEqual({
      created: true,
      sourceId: "favorite-cycle-1",
      sourceTimestamp: "2026-08-24T15:42:00.000Z",
    });
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        userId: "actor-1",
        listingId: "listing-1",
        createdAt: new Date("2026-08-24T15:42:00.000Z"),
      },
      select: { id: true, createdAt: true },
    });
  });

  it("reports a duplicate favorite without rewriting it", async () => {
    mockCreate.mockRejectedValue({ code: "P2002" });

    const result = await new PrismaFavoritesRepository().upsert({
      userId: "actor-1",
      listingId: "listing-1",
      createdAt: "2026-08-24T15:42:00.000Z",
    });

    expect(result).toEqual({ created: false });
  });

  it("persists a durable cycle identity in JSON fallback and reuses duplicate semantics", async () => {
    mockEnv.enableCategoriesJsonFallback = true;
    mockCreate.mockRejectedValue(new Error("database unavailable"));
    let stored: Array<Record<string, unknown>> = [];
    mockReadFavorites.mockImplementation(() => stored);
    mockWriteFavorites.mockImplementation((_path: string, rows: Array<Record<string, unknown>>) => {
      stored = rows;
    });
    const repository = new PrismaFavoritesRepository();
    const input = { userId: "actor-1", listingId: "listing-1", createdAt: "2026-08-24T15:42:00.000Z" };

    const first = await repository.upsert(input);
    const duplicate = await repository.upsert(input);

    expect(first).toEqual({
      created: true,
      sourceId: expect.stringMatching(/^fav_/),
      sourceTimestamp: input.createdAt,
    });
    expect(stored).toEqual([expect.objectContaining({ id: first.created && first.sourceId, ...input })]);
    expect(duplicate).toEqual({ created: false });
    expect(mockWriteFavorites).toHaveBeenCalledTimes(1);
  });
});
