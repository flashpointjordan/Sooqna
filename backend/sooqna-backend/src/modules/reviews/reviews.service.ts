import { generateId } from "../../utils/ids";
import { nowIso } from "../../utils/time";
import { AppError } from "../../shared/errors/appError";
import { prisma } from "../../config/prisma";
import type { ReviewsRepository } from "./repositories/reviews.repository";
import type { Review, PublicReview, PublicSellerProfile } from "./reviews.types";
import { enqueueNotificationEvent, type EnqueueNotificationEventInput } from "../notifications/notifications.producer";
import { logger } from "../../config/logger";

export class ReviewsService {
  constructor(
    private readonly repo: ReviewsRepository,
    private readonly enqueue: (input: EnqueueNotificationEventInput) => Promise<unknown> = enqueueNotificationEvent
  ) {}

  async createReview(input: {
    sellerId: string;
    reviewerId: string;
    listingId: string;
    rating: number;
    comment: string;
  }): Promise<Review> {
    if (input.sellerId === input.reviewerId) {
      throw new AppError(400, "You cannot review yourself.", "VALIDATION_ERROR");
    }
    if (input.rating < 1 || input.rating > 5 || !Number.isInteger(input.rating)) {
      throw new AppError(400, "Rating must be an integer between 1 and 5.", "VALIDATION_ERROR");
    }

    const listing = await prisma.listing.findFirst({
      where: { id: input.listingId, deletedAt: null },
    });
    if (!listing) {
      throw new AppError(404, "Listing not found.", "NOT_FOUND");
    }
    if (listing.ownerId !== input.sellerId) {
      throw new AppError(400, "Seller does not own this listing.", "VALIDATION_ERROR");
    }

    const existing = await this.repo.findByReviewerAndListing(input.reviewerId, input.listingId);
    if (existing) {
      throw new AppError(409, "You have already reviewed this listing.", "DUPLICATE_REVIEW");
    }

    const now = nowIso();
    const review = await this.repo.create({
      id: generateId("rev"),
      sellerId: input.sellerId,
      reviewerId: input.reviewerId,
      listingId: input.listingId,
      rating: input.rating,
      comment: input.comment.trim(),
      createdAt: now,
      updatedAt: now,
    });

    await this.recalculateSellerStats(input.sellerId);
    try {
      const [reviewer, authoritativeListing] = await Promise.all([
        prisma.user.findUnique({
          where: { firebaseUid: input.reviewerId },
          select: { name: true },
        }),
        prisma.listing.findFirst({
          where: { id: input.listingId, ownerId: input.sellerId, deletedAt: null },
          select: { id: true, ownerId: true, title: true },
        }),
      ]);

      if (reviewer?.name && authoritativeListing?.title) {
        await this.enqueue({
          aggregateType: "review",
          aggregateId: review.id,
          recipientId: input.sellerId,
          dedupeKey: `review:${review.id}:${input.sellerId}`,
          payload: {
            eventType: "REVIEW_RECEIVED",
            recipientId: input.sellerId,
            reviewId: review.id,
            reviewerId: input.reviewerId,
            reviewerName: reviewer.name,
            listingId: authoritativeListing.id,
            listingTitle: authoritativeListing.title,
            rating: review.rating,
          },
        });
      } else {
        logger.error("Notification event enqueue failed", {
          eventType: "REVIEW_RECEIVED",
          reviewId: review.id,
          outcome: "failed",
        });
      }
    } catch {
      logger.error("Notification event enqueue failed", {
        eventType: "REVIEW_RECEIVED",
        reviewId: review.id,
        outcome: "failed",
      });
    }
    return review;
  }

  async getSellerReviews(
    sellerId: string,
    limit = 20,
    offset = 0
  ): Promise<{ items: PublicReview[]; total: number }> {
    return this.repo.listBySeller(sellerId, limit, offset);
  }

  async getListingReviews(listingId: string, limit = 5): Promise<PublicReview[]> {
    return this.repo.listByListing(listingId, limit);
  }

  async getPublicSellerProfile(sellerUid: string): Promise<PublicSellerProfile> {
    const user = await prisma.user.findUnique({
      where: { firebaseUid: sellerUid },
    });
    if (!user) {
      throw new AppError(404, "Seller not found.", "NOT_FOUND");
    }

    return {
      uid: user.firebaseUid,
      fullName: user.name,
      photoURL: user.avatarUrl ?? "",
      bio: user.bio ?? "",
      stats: {
        avgRating: user.avgRating,
        totalReviews: user.totalReviews,
        totalListings: user.totalListings,
        totalSold: user.totalSold,
        memberSince: user.createdAt.toISOString(),
        isEmailVerified: user.isEmailVerified,
        isPhoneVerified: user.isPhoneVerified,
        isIdVerified: user.isIdVerified,
      },
    };
  }

  private async recalculateSellerStats(sellerId: string): Promise<void> {
    const result = await prisma.review.aggregate({
      where: { sellerId },
      _avg: { rating: true },
      _count: { id: true },
    });

    const totalListings = await prisma.listing.count({
      where: { ownerId: sellerId, deletedAt: null },
    });

    const totalSold = await prisma.listing.count({
      where: { ownerId: sellerId, status: "sold", deletedAt: null },
    });

    await prisma.user.update({
      where: { firebaseUid: sellerId },
      data: {
        avgRating: Math.round((result._avg.rating ?? 0) * 10) / 10,
        totalReviews: result._count.id,
        totalListings,
        totalSold,
        updatedAt: new Date(),
      },
    });
  }
}
