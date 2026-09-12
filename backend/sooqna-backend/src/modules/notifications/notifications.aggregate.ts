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

function parsePositiveVersion(value: NotificationMetadata[string]): bigint | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  return BigInt(value);
}
