import { NotificationOutboxState, NotificationType, Prisma, type PrismaClient } from "@prisma/client";
import { AppError } from "../../shared/errors/appError";
import type { NotificationEventPayload } from "./notifications.types";

export type EnqueueNotificationEventInput = {
  payload: NotificationEventPayload;
  aggregateType: string;
  aggregateId: string;
  recipientId?: string;
  dedupeKey: string;
  aggregationKey?: string;
};

type OutboxWriter = Pick<PrismaClient, "notificationOutbox"> | Prisma.TransactionClient;

/**
 * Records domain facts for asynchronous delivery.  Rendering intentionally belongs
 * to the worker so the durable record never becomes a cache of private copy.
 */
export async function enqueueNotificationEvent(input: EnqueueNotificationEventInput, tx?: OutboxWriter) {
  const writer = tx ?? (await import("../../config/prisma")).prisma;
  const payload = projectNotificationEventPayload(input.payload);
  const recipientId = input.recipientId ?? payload.recipientId;
  if (input.recipientId && input.recipientId !== payload.recipientId) {
    throw new AppError(400, "Notification recipient does not match event payload.", "VALIDATION_ERROR");
  }
  if (!input.aggregateType || !input.aggregateId || !input.dedupeKey) {
    throw new AppError(400, "Notification outbox identifiers are required.", "VALIDATION_ERROR");
  }
  if (input.aggregationKey !== undefined && !isAggregationKeyPrefix(input.aggregationKey)) {
    throw new AppError(400, "Notification aggregation key is invalid.", "VALIDATION_ERROR");
  }
  const availableAt = new Date();
  const durablePayload = input.aggregationKey ? { ...payload, _aggregationKey: input.aggregationKey } : payload;
  return writer.notificationOutbox.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: {
      eventType: payload.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      recipientId,
      payload: durablePayload as unknown as Prisma.InputJsonValue,
      dedupeKey: input.dedupeKey,
      state: NotificationOutboxState.PENDING,
      attempts: 0,
      availableAt,
    },
    update: {},
  });
}
function isAggregationKeyPrefix(value: string): boolean { return value.length > 0 && value.length <= 160 && /^[A-Za-z0-9:_-]+$/.test(value); }

function objectPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "Invalid notification event payload.", "VALIDATION_ERROR");
  return value as Record<string, unknown>;
}
function requiredString(source: Record<string, unknown>, key: string): string {
  if (typeof source[key] !== "string" || !source[key]) throw new AppError(400, `Notification payload ${key} is required.`, "VALIDATION_ERROR");
  return source[key];
}
function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  if (source[key] === undefined) return undefined;
  if (typeof source[key] !== "string") throw new AppError(400, `Notification payload ${key} is invalid.`, "VALIDATION_ERROR");
  return source[key];
}

/** Projects only known event facts; extra/rendered/private caller fields never reach durable JSON. */
export function projectNotificationEventPayload(value: unknown): NotificationEventPayload {
  const source = objectPayload(value); const eventType = requiredString(source, "eventType") as NotificationType; const recipientId = requiredString(source, "recipientId");
  const base = { eventType, recipientId };
  switch (eventType) {
    case "MESSAGE_RECEIVED": { const listingTitle = optionalString(source, "listingTitle"); return { ...base, eventType, conversationId: requiredString(source, "conversationId"), messageId: requiredString(source, "messageId"), senderId: requiredString(source, "senderId"), senderName: requiredString(source, "senderName"), listingId: requiredString(source, "listingId"), ...(listingTitle === undefined ? {} : { listingTitle }), messagePreview: requiredString(source, "messagePreview") } as NotificationEventPayload; }
    case "LISTING_APPROVED": return { ...base, eventType, listingId: requiredString(source, "listingId"), listingTitle: requiredString(source, "listingTitle") } as NotificationEventPayload;
    case "LISTING_REJECTED": return { ...base, eventType, listingId: requiredString(source, "listingId"), listingTitle: requiredString(source, "listingTitle"), rejectionReason: requiredString(source, "rejectionReason") } as NotificationEventPayload;
    case "LISTING_EXPIRING": return { ...base, eventType, listingId: requiredString(source, "listingId"), listingTitle: requiredString(source, "listingTitle"), expiresAt: requiredString(source, "expiresAt") } as NotificationEventPayload;
    case "LISTING_EXPIRED": return { ...base, eventType, listingId: requiredString(source, "listingId"), listingTitle: requiredString(source, "listingTitle") } as NotificationEventPayload;
    case "LISTING_FAVORITED_AGGREGATE": {
      if (typeof source.favoriteCount !== "number") throw new AppError(400, "Notification payload favoriteCount is invalid.", "VALIDATION_ERROR");
      const sourceTimestamp = requiredString(source, "sourceTimestamp");
      const sourceDate = new Date(sourceTimestamp);
      if (Number.isNaN(sourceDate.getTime()) || sourceDate.toISOString() !== sourceTimestamp) throw new AppError(400, "Notification payload sourceTimestamp is invalid.", "VALIDATION_ERROR");
      return { ...base, eventType, listingId: requiredString(source, "listingId"), listingTitle: requiredString(source, "listingTitle"), favoriteCount: source.favoriteCount, sourceTimestamp } as NotificationEventPayload;
    }
    case "REVIEW_RECEIVED": { if (typeof source.rating !== "number") throw new AppError(400, "Notification payload rating is invalid.", "VALIDATION_ERROR"); return { ...base, eventType, reviewId: requiredString(source, "reviewId"), reviewerId: requiredString(source, "reviewerId"), reviewerName: requiredString(source, "reviewerName"), listingId: requiredString(source, "listingId"), listingTitle: requiredString(source, "listingTitle"), rating: source.rating } as NotificationEventPayload; }
    case "SAVED_SEARCH_MATCHES": {
      if (!Array.isArray(source.matchingListingIds) || !source.matchingListingIds.every((item) => typeof item === "string") || typeof source.totalCount !== "number") throw new AppError(400, "Invalid saved-search notification payload.", "VALIDATION_ERROR");
      const rawQuery = objectPayload(source.query); const query = Object.fromEntries(Object.entries(rawQuery).filter(([key, item]) => ["q", "category", "city", "condition", "sort"].includes(key) ? typeof item === "string" : ["minPrice", "maxPrice", "priceMin", "priceMax"].includes(key) ? typeof item === "number" : false));
      return { ...base, eventType, savedSearchId: requiredString(source, "savedSearchId"), savedSearchName: requiredString(source, "savedSearchName"), query, matchingListingIds: source.matchingListingIds, totalCount: source.totalCount } as NotificationEventPayload;
    }
    case "SYSTEM_ANNOUNCEMENT": { const actionUrl = source.actionUrl === null ? null : optionalString(source, "actionUrl"); return { ...base, eventType, announcementId: requiredString(source, "announcementId"), title: requiredString(source, "title"), body: requiredString(source, "body"), ...(actionUrl === undefined ? {} : { actionUrl }) } as NotificationEventPayload; }
    case "SECURITY_ALERT": return { ...base, eventType, alertId: requiredString(source, "alertId") } as NotificationEventPayload;
    default: throw new AppError(400, "Invalid notification event type.", "VALIDATION_ERROR");
  }
}
