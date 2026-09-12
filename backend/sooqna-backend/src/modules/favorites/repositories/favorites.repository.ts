import * as path from "node:path";
import { env } from "../../../config/env";
import { prisma } from "../../../config/prisma";
import { readJsonArrayFile, writeJsonArrayFile } from "../../../utils/fileStore";
import type { FavoriteRecord } from "../favorites.types";

export interface FavoritesRepository {
  listByUser(userId: string): Promise<FavoriteRecord[]>;
  upsert(record: FavoriteRecord): Promise<{ created: boolean }>;
  remove(userId: string, listingId: string): Promise<void>;
  countByListing(listingId: string): Promise<number>;
}

const favoritesDataPath = path.resolve(
  process.cwd(),
  "src/modules/favorites/repositories/favorites.data.json"
);

function useJsonFallback(): boolean {
  return env.enableCategoriesJsonFallback;
}

export class PrismaFavoritesRepository implements FavoritesRepository {
  async listByUser(userId: string): Promise<FavoriteRecord[]> {
    try {
      const items = await prisma.favorite.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
      return items.map((item) => ({
        userId: item.userId,
        listingId: item.listingId ?? "",
        createdAt: item.createdAt.toISOString(),
      }));
    } catch (error) {
      if (useJsonFallback()) {
        const items = readJsonArrayFile<FavoriteRecord>(favoritesDataPath);
        return items
          .filter((item) => item.userId === userId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }
      throw new Error("Failed to fetch favorites.", { cause: error });
    }
  }

  async upsert(record: FavoriteRecord): Promise<{ created: boolean }> {
    try {
      const result = await prisma.favorite.createMany({
        data: {
          userId: record.userId,
          listingId: record.listingId,
          createdAt: new Date(record.createdAt),
        },
        skipDuplicates: true,
      });
      return { created: result.count === 1 };
    } catch (error) {
      if (useJsonFallback()) {
        const items = readJsonArrayFile<FavoriteRecord>(favoritesDataPath);
        const exists = items.some(
          (item) => item.userId === record.userId && item.listingId === record.listingId
        );
        if (!exists) {
          items.push(record);
          writeJsonArrayFile(favoritesDataPath, items);
        }
        return { created: !exists };
      }
      throw new Error("Failed to save favorite.", { cause: error });
    }
  }

  async remove(userId: string, listingId: string): Promise<void> {
    try {
      await prisma.favorite.deleteMany({
        where: { userId, listingId },
      });
    } catch (error) {
      if (useJsonFallback()) {
        const items = readJsonArrayFile<FavoriteRecord>(favoritesDataPath);
        const filtered = items.filter(
          (item) => !(item.userId === userId && item.listingId === listingId)
        );
        writeJsonArrayFile(favoritesDataPath, filtered);
        return;
      }
      throw new Error("Failed to remove favorite.", { cause: error });
    }
  }

  async countByListing(listingId: string): Promise<number> {
    try {
      return await prisma.favorite.count({
        where: { listingId },
      });
    } catch (error) {
      if (useJsonFallback()) {
        const items = readJsonArrayFile<FavoriteRecord>(favoritesDataPath);
        return items.filter((item) => item.listingId === listingId).length;
      }
      throw new Error("Failed to count favorites.", { cause: error });
    }
  }
}

