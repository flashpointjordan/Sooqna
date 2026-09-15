export type AuditAction =
  | "listing.create"
  | "listing.update"
  | "listing.publish"
  | "listing.unpublish"
  | "listing.renew"
  | "listing.expire"
  | "listing.delete"
  | "listing.sold"
  | "listing.archive"
  | "listing.feature"
  | "listing.unfeature"
  | "favorite.add"
  | "favorite.remove"
  | "message.create"
  | "message.read"
  | "review.create"
  | "report.submit"
  | "report.update"
  | "admin.listing.publish"
  | "admin.listing.reject"
  | "admin.listing.archive"
  | "admin.listing.sold"
  | "admin.listing.feature"
  | "admin.listing.unfeature"
  | "admin.listing.bulk"
  | "admin.user.update"
  | "admin.report.update"
  | "admin.category.create"
  | "admin.category.update"
  | "admin.city.create"
  | "admin.city.update"
  | "admin.notification.broadcast"
  | "security.content_blocked";

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  action: AuditAction;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
