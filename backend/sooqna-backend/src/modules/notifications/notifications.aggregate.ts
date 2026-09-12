import { NotificationType } from "@prisma/client";
import type { NotificationMetadata } from "./notifications.types";

export function isStaleAggregate(
  type: NotificationType,
  current: NotificationMetadata,
  incoming: NotificationMetadata
): boolean {
  if (type !== NotificationType.LISTING_FAVORITED_AGGREGATE) return false;
  const currentTimestamp = current.sourceTimestamp;
  const incomingTimestamp = incoming.sourceTimestamp;
  if (typeof currentTimestamp !== "string" || typeof incomingTimestamp !== "string") return false;
  return incomingTimestamp <= currentTimestamp;
}
