import { nowIso } from "../../utils/time";
import { AppError } from "../../shared/errors/appError";
import { logger } from "../../config/logger";
import { PrismaListingsRepository } from "../listings/repositories/listings.repository";
import { enqueueNotificationEvent, type EnqueueNotificationEventInput } from "../notifications/notifications.producer";
import type { FavoritesRepository } from "./repositories/favorites.repository";
import { trackEngagementEvent } from "../engagement/engagement.service";

export class FavoritesService {
  private readonly listingsRepo = new PrismaListingsRepository();

  constructor(
    private readonly repo: FavoritesRepository,
    private readonly enqueue = enqueueNotificationEvent
  ) {}

  async add(userId: string, listingId: string): Promise<{ listingId: string; favoritesCount: number; favorited: boolean }> {
    const listing = await this.listingsRepo.findById(listingId);
    if (!listing) {
      throw new AppError(404, "Listing not found", "NOT_FOUND");
    }
    const favorite = await this.repo.upsert({ userId, listingId, createdAt: nowIso() });
    const favoritesCount = await this.syncFavoritesCounter(listingId);
    await trackEngagementEvent({
      eventType: "favorite",
      listingId,
      actorId: userId,
      metadata: { action: "add" },
    });
    if (favorite.created && listing.ownerId && listing.ownerId !== userId) {
      try {
        const hour = new Date().toISOString().slice(0, 13);
        await this.enqueue({
          aggregateType: "listing",
          aggregateId: listingId,
          recipientId: listing.ownerId,
          dedupeKey: `favorite:${listingId}:${userId}`,
          aggregationKey: `listing-favorite:${listingId}:${hour}`,
          payload: {
            eventType: "LISTING_FAVORITED_AGGREGATE",
            recipientId: listing.ownerId,
            listingId,
            listingTitle: listing.title,
            favoriteCount: favoritesCount,
          },
        } satisfies EnqueueNotificationEventInput);
      } catch {
        logger.error("Notification event enqueue failed", {
          eventType: "LISTING_FAVORITED_AGGREGATE",
          listingId,
          outcome: "failed",
        });
      }
    }
    return { listingId, favoritesCount, favorited: true };
  }

  async remove(userId: string, listingId: string): Promise<{ listingId: string; favoritesCount: number; favorited: boolean }> {
    const listing = await this.listingsRepo.findById(listingId);
    if (!listing) {
      throw new AppError(404, "Listing not found", "NOT_FOUND");
    }
    await this.repo.remove(userId, listingId);
    const favoritesCount = await this.syncFavoritesCounter(listingId);
    await trackEngagementEvent({
      eventType: "favorite",
      listingId,
      actorId: userId,
      metadata: { action: "remove" },
    });
    return { listingId, favoritesCount, favorited: false };
  }

  async list(userId: string): Promise<string[]> {
    const records = await this.repo.listByUser(userId);
    return records.map((record) => record.listingId);
  }

  private async syncFavoritesCounter(listingId: string): Promise<number> {
    const listing = await this.listingsRepo.findById(listingId);
    if (!listing) return 0;
    const count = await this.repo.countByListing(listingId);
    if (listing.favoritesCount !== count) {
      await this.listingsRepo.update(listingId, {
        ...listing,
        favoritesCount: count,
        updatedAt: nowIso(),
      });
    }
    return count;
  }
}

