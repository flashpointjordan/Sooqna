import type { NotificationCategory, NotificationType } from "@prisma/client";
import { AppError } from "../../shared/errors/appError";

export type SavedSearchQueryFacts = {
  q?: string;
  category?: string;
  city?: string;
  minPrice?: number;
  maxPrice?: number;
  priceMin?: number;
  priceMax?: number;
  condition?: "new" | "used";
  sort?: "price_asc" | "price_desc" | "newest";
};

export type NotificationEventPayload =
  | {
      eventType: "MESSAGE_RECEIVED";
      recipientId: string;
      conversationId: string;
      messageId: string;
      senderId: string;
      senderName: string;
      listingId: string;
      listingTitle?: string;
      messagePreview: string;
    }
  | {
      eventType: "LISTING_APPROVED";
      recipientId: string;
      listingId: string;
      listingTitle: string;
    }
  | {
      eventType: "LISTING_REJECTED";
      recipientId: string;
      listingId: string;
      listingTitle: string;
      rejectionReason: string;
    }
  | {
      eventType: "LISTING_EXPIRING";
      recipientId: string;
      listingId: string;
      listingTitle: string;
      expiresAt: string;
    }
  | {
      eventType: "LISTING_EXPIRED";
      recipientId: string;
      listingId: string;
      listingTitle: string;
    }
  | {
      eventType: "LISTING_FAVORITED_AGGREGATE";
      recipientId: string;
      listingId: string;
      listingTitle: string;
      favoriteCount: number;
      sourceTimestamp: string;
      sourceId: string;
      sourceVersion: string;
    }
  | {
      eventType: "REVIEW_RECEIVED";
      recipientId: string;
      reviewId: string;
      reviewerId: string;
      reviewerName: string;
      listingId: string;
      listingTitle: string;
      rating: number;
    }
  | {
      eventType: "SAVED_SEARCH_MATCHES";
      recipientId: string;
      savedSearchId: string;
      savedSearchName: string;
      query: SavedSearchQueryFacts;
      matchingListingIds: string[];
      totalCount: number;
    }
  | {
      eventType: "SYSTEM_ANNOUNCEMENT";
      recipientId: string;
      announcementId: string;
      title: string;
      body: string;
      actionUrl?: string | null;
    }
  | {
      eventType: "SECURITY_ALERT";
      recipientId: string;
      alertId: string;
    };

export type NotificationCursor = {
  createdAt: string;
  id: string;
};

export type NotificationListQuery = {
  limit: number;
  cursor?: string;
  category?: NotificationCategory;
  unread?: boolean;
};

export type NotificationMetadata = Record<string, string | number | string[]>;

export type NotificationDto = {
  id: string;
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  body: string;
  actionUrl: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: NotificationMetadata;
  readAt: string | null;
  createdAt: string;
};

export type ManageableNotificationCategory = "MESSAGES" | "LISTINGS" | "ENGAGEMENT" | "SAVED_SEARCHES";

export type NotificationPreferencesDto = Record<ManageableNotificationCategory, boolean>;

export type NotificationUnreadCountsDto = {
  total: number;
  byCategory: Record<NotificationCategory, number>;
};

function cursorValidationError(): never {
  throw new AppError(400, "Invalid notification cursor", "VALIDATION_ERROR");
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  if (!isCanonicalIsoTimestamp(cursor.createdAt) || !isBoundedId(cursor.id)) {
    return cursorValidationError();
  }
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }), "utf8").toString("base64url");
}

export function decodeNotificationCursor(value: string): NotificationCursor {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return cursorValidationError();
  }

  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) return cursorValidationError();
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return cursorValidationError();
    const parsedObject = parsed as Record<string, unknown>;
    const keys = Object.keys(parsedObject);
    if (keys.length !== 2 || !keys.includes("createdAt") || !keys.includes("id")) return cursorValidationError();
    const { createdAt, id } = parsedObject;
    if (!isCanonicalIsoTimestamp(createdAt) || !isBoundedId(id)) return cursorValidationError();
    return { createdAt, id };
  } catch {
    return cursorValidationError();
  }
}
