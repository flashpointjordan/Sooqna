import { NotificationType } from "@prisma/client";
import type { NotificationMetadata } from "./notifications.types";

export function isStaleAggregate(
  type: NotificationType,
  current: NotificationMetadata,
  incoming: NotificationMetadata
): boolean {
  if (type !== NotificationType.LISTING_FAVORITED_AGGREGATE) return false;
  const currentVersion = parsePositiveVersion(current.sourceVersion);
  const incomingVersion = parsePositiveVersion(incoming.sourceVersion);
  if (currentVersion !== null && incomingVersion !== null) {
    return incomingVersion <= currentVersion;
  }
  const currentTimestamp = current.sourceTimestamp;
  const incomingTimestamp = incoming.sourceTimestamp;
  if (typeof currentTimestamp !== "string" || typeof incomingTimestamp !== "string") return false;
  return incomingTimestamp <= currentTimestamp;
}

export function mergeSavedSearchAggregate(
  current: NotificationMetadata,
  incoming: NotificationMetadata
): NotificationMetadata {
  const currentIds = Array.isArray(current.matchingListingIds) ? current.matchingListingIds : [];
  const incomingIds = Array.isArray(incoming.matchingListingIds) ? incoming.matchingListingIds : [];
  const currentTotal = validCount(current.totalCount);
  const incomingTotal = validCount(incoming.totalCount);
  return {
    ...incoming,
    matchingListingIds: [...new Set([...currentIds, ...incomingIds])].slice(0, 10),
    totalCount: currentTotal + incomingTotal,
  };
}

function validCount(value: NotificationMetadata[string]): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function parsePositiveVersion(value: NotificationMetadata[string]): bigint | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  return BigInt(value);
}
