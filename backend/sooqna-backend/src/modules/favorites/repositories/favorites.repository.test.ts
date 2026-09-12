const mockCreateMany = jest.fn();

jest.mock("../../../config/prisma", () => ({
  prisma: {
    favorite: {
      createMany: mockCreateMany,
    },
  },
}));
jest.mock("../../../config/env", () => ({
  env: { enableCategoriesJsonFallback: false },
}));

import { PrismaFavoritesRepository } from "./favorites.repository";

describe("PrismaFavoritesRepository.upsert", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reports a newly inserted favorite", async () => {
    mockCreateMany.mockResolvedValue({ count: 1 });

    const result = await new PrismaFavoritesRepository().upsert({
      userId: "actor-1",
      listingId: "listing-1",
      createdAt: "2026-08-24T15:42:00.000Z",
    });

    expect(result).toEqual({ created: true });
    expect(mockCreateMany).toHaveBeenCalledWith({
      data: {
        userId: "actor-1",
        listingId: "listing-1",
        createdAt: new Date("2026-08-24T15:42:00.000Z"),
      },
      skipDuplicates: true,
    });
  });

  it("reports a duplicate favorite without rewriting it", async () => {
    mockCreateMany.mockResolvedValue({ count: 0 });

    const result = await new PrismaFavoritesRepository().upsert({
      userId: "actor-1",
      listingId: "listing-1",
      createdAt: "2026-08-24T15:42:00.000Z",
    });

    expect(result).toEqual({ created: false });
  });
});
