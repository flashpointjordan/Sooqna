import * as path from "node:path";
import { Prisma } from "@prisma/client";
import { env } from "../../../config/env";
import { prisma } from "../../../config/prisma";
import { withMarketplaceJsonLock } from "../../../shared/database/marketplaceJsonLock";
import { readJsonArrayFile, writeJsonArrayFileAtomically } from "../../../utils/fileStore";
import { generateId } from "../../../utils/ids";
import type { FavoriteRecord } from "../favorites.types";
import type { Listing } from "../../listings/listings.types";

export type FavoriteUpsertResult =
  | { created: true; sourceId: string; sourceTimestamp: string; sourceVersion: string; favoriteCount: number }
  | { created: false; favoriteCount: number };

export type FavoriteRemoveResult = { removed: boolean; favoriteCount: number };

export interface FavoritesRepository {
  listByUser(userId: string): Promise<FavoriteRecord[]>;
  upsert(record: FavoriteRecord): Promise<FavoriteUpsertResult>;
  remove(userId: string, listingId: string): Promise<FavoriteRemoveResult>;
  countByListing(listingId: string): Promise<number>;
}

const favoritesDataPath = path.resolve(
  process.cwd(),
  "src/modules/favorites/repositories/favorites.data.json"
);
const listingsDataPath = path.resolve(
  process.cwd(),
  "src/modules/listings/repositories/listings.data.json"
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
          .filter((item) => item.userId === userId && !item.deletedAt)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }
      throw new Error("Failed to fetch favorites.", { cause: error });
    }
  }

  async upsert(record: FavoriteRecord): Promise<FavoriteUpsertResult> {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${record.listingId}, 0))`);
        const existing = await tx.favorite.findUnique({
          where: { userId_listingId: { userId: record.userId, listingId: record.listingId } },
          select: { id: true },
        });
        if (existing) {
          const favoriteCount = await tx.favorite.count({ where: { listingId: record.listingId } });
          return { created: false, favoriteCount };
        }
        const created = await tx.favorite.create({
          data: { userId: record.userId, listingId: record.listingId, createdAt: new Date(record.createdAt) },
          select: { id: true, createdAt: true, notificationVersion: true },
        });
        const favoriteCount = await tx.favorite.count({ where: { listingId: record.listingId } });
        await tx.listing.updateMany({
          where: { id: record.listingId, deletedAt: null },
          data: { favoritesCount: favoriteCount },
        });
        return {
          created: true,
          sourceId: created.id,
          sourceTimestamp: created.createdAt.toISOString(),
          sourceVersion: created.notificationVersion.toString(),
          favoriteCount,
        };
      });
    } catch (error) {
      if (useJsonFallback()) {
        return withMarketplaceJsonLock(async () => {
          const items = readJsonArrayFile<FavoriteRecord>(favoritesDataPath);
          const active = items.filter((item) => !item.deletedAt);
          const exists = active.some((item) => item.userId === record.userId && item.listingId === record.listingId);
          if (exists) {
            const favoriteCount = active.filter((item) => item.listingId === record.listingId).length;
            updateJsonListingFavoriteCount(record.listingId, favoriteCount);
            return { created: false, favoriteCount };
          }
          const sourceId = generateId("fav");
          const sourceVersion = (items.reduce((highest, item) => {
            if (item.listingId !== record.listingId || !item.notificationVersion) return highest;
            const value = BigInt(item.notificationVersion);
            return value > highest ? value : highest;
          }, 0n) + 1n).toString();
          items.push({ ...record, id: sourceId, notificationVersion: sourceVersion, deletedAt: null });
          const favoriteCount = items.filter((item) => item.listingId === record.listingId && !item.deletedAt).length;
          writeJsonArrayFileAtomically(favoritesDataPath, items);
          updateJsonListingFavoriteCount(record.listingId, favoriteCount);
          return { created: true, sourceId, sourceTimestamp: record.createdAt, sourceVersion, favoriteCount };
        });
      }
      throw new Error("Failed to save favorite.", { cause: error });
    }
  }

  async remove(userId: string, listingId: string): Promise<FavoriteRemoveResult> {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${listingId}, 0))`);
        const deleted = await tx.favorite.deleteMany({ where: { userId, listingId } });
        const favoriteCount = await tx.favorite.count({ where: { listingId } });
        await tx.listing.updateMany({ where: { id: listingId, deletedAt: null }, data: { favoritesCount: favoriteCount } });
        return { removed: deleted.count > 0, favoriteCount };
      });
    } catch (error) {
      if (useJsonFallback()) {
        return withMarketplaceJsonLock(async () => {
          const items = readJsonArrayFile<FavoriteRecord>(favoritesDataPath);
          const target = items.find((item) => item.userId === userId && item.listingId === listingId && !item.deletedAt);
          if (target) target.deletedAt = new Date().toISOString();
          const favoriteCount = items.filter((item) => item.listingId === listingId && !item.deletedAt).length;
          if (target) writeJsonArrayFileAtomically(favoritesDataPath, items);
          updateJsonListingFavoriteCount(listingId, favoriteCount);
          return { removed: Boolean(target), favoriteCount };
        });
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
        return items.filter((item) => item.listingId === listingId && !item.deletedAt).length;
      }
      throw new Error("Failed to count favorites.", { cause: error });
    }
  }
}

function updateJsonListingFavoriteCount(listingId: string, favoriteCount: number): void {
  const listings = readJsonArrayFile<Listing>(listingsDataPath);
  const listing = listings.find((item) => item.id === listingId && item.deletedAt === null);
  if (!listing || listing.favoritesCount === favoriteCount) return;
  listing.favoritesCount = favoriteCount;
  writeJsonArrayFileAtomically(listingsDataPath, listings);
}

