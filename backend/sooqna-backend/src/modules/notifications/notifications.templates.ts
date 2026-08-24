import { NotificationCategory, NotificationType } from "@prisma/client";
import { AppError } from "../../shared/errors/appError";
import type {
  NotificationEventPayload,
  NotificationMetadata,
  SavedSearchQueryFacts,
} from "./notifications.types";

export type RenderedNotification = {
  category: NotificationCategory;
  title: string;
  body: string;
  actionUrl: string | null;
  entityType: string;
  entityId: string;
  metadata: NotificationMetadata;
};

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;
const HAS_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;
const SAVED_SEARCH_STRING_QUERY_PARAMS = [
  ["q", "search"],
  ["category", "category"],
  ["city", "city"],
  ["sort", "sort"],
] as const satisfies ReadonlyArray<readonly [keyof SavedSearchQueryFacts, string]>;
const LISTING_SORT_VALUES = new Set(["price_asc", "price_desc", "newest"]);
const CATEGORY_BY_TYPE = {
  MESSAGE_RECEIVED: NotificationCategory.MESSAGES,
  LISTING_APPROVED: NotificationCategory.LISTINGS,
  LISTING_REJECTED: NotificationCategory.LISTINGS,
  LISTING_EXPIRING: NotificationCategory.LISTINGS,
  LISTING_EXPIRED: NotificationCategory.LISTINGS,
  LISTING_FAVORITED_AGGREGATE: NotificationCategory.ENGAGEMENT,
  REVIEW_RECEIVED: NotificationCategory.ENGAGEMENT,
  SAVED_SEARCH_MATCHES: NotificationCategory.SAVED_SEARCHES,
  SYSTEM_ANNOUNCEMENT: NotificationCategory.SYSTEM,
  SECURITY_ALERT: NotificationCategory.SECURITY,
} satisfies Record<NotificationType, NotificationCategory>;

function validationError(): never {
  throw new AppError(400, "Internal action URL required", "VALIDATION_ERROR");
}

export function assertInternalActionUrl(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    HAS_CONTROL_CHARACTERS.test(value)
  ) {
    return validationError();
  }
  return value;
}

function cleanText(value: string, maxCodePoints: number): string {
  return Array.from(value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim())
    .slice(0, maxCodePoints)
    .join("");
}

function cleanId(value: string): string {
  return cleanText(value, 128);
}

function listingUrl(listingId: string): string {
  return `/listings/${encodeURIComponent(cleanId(listingId))}`;
}

function canonicalSavedSearchUrl(query: SavedSearchQueryFacts): string {
  const params = new URLSearchParams();
  for (const [key, parameter] of SAVED_SEARCH_STRING_QUERY_PARAMS) {
    const value = query[key];
    if (typeof value === "string") {
      const cleaned = cleanText(value, 120);
      if (cleaned && (key !== "sort" || LISTING_SORT_VALUES.has(cleaned))) {
        params.set(parameter, cleaned);
      }
    }
  }
  const priceMin = query.priceMin ?? query.minPrice;
  const priceMax = query.priceMax ?? query.maxPrice;
  if (typeof priceMin === "number" && Number.isFinite(priceMin) && priceMin >= 0) {
    params.set("priceMin", String(priceMin));
  }
  if (typeof priceMax === "number" && Number.isFinite(priceMax) && priceMax >= 0) {
    params.set("priceMax", String(priceMax));
  }
  const search = params.toString();
  return search ? `/listings?${search}` : "/listings";
}

function requireIntegerInRange(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new AppError(400, `${field} is invalid`, "VALIDATION_ERROR");
  }
  return value;
}

function categoryFor(type: NotificationType): NotificationCategory {
  return CATEGORY_BY_TYPE[type];
}

function assertNever(value: never): never {
  throw new Error(`Unhandled notification type: ${String(value)}`);
}

function render(type: NotificationType, payload: NotificationEventPayload): RenderedNotification {
  if (type !== payload.eventType) {
    throw new AppError(400, "Notification event type does not match payload", "VALIDATION_ERROR");
  }

  switch (payload.eventType) {
    case NotificationType.MESSAGE_RECEIVED: {
      const senderName = cleanText(payload.senderName, 80) || "مستخدم";
      const listingTitle = payload.listingTitle ? cleanText(payload.listingTitle, 100) : "إعلانك";
      const preview = cleanText(payload.messagePreview, 120);
      return {
        category: categoryFor(payload.eventType),
        title: cleanText(`رسالة جديدة من ${senderName}`, 100),
        body: cleanText(`بخصوص ${listingTitle}${preview ? `: ${preview}` : ""}`, 240),
        actionUrl: `/messages?conversation=${encodeURIComponent(cleanId(payload.conversationId))}`,
        entityType: "conversation",
        entityId: cleanId(payload.conversationId),
        metadata: {
          listingId: cleanId(payload.listingId),
          messageId: cleanId(payload.messageId),
          senderId: cleanId(payload.senderId),
        },
      };
    }
    case NotificationType.LISTING_APPROVED:
      return {
        category: categoryFor(payload.eventType),
        title: "تمت الموافقة على إعلانك",
        body: cleanText(`أصبح إعلان «${payload.listingTitle}» منشوراً الآن.`, 240),
        actionUrl: listingUrl(payload.listingId),
        entityType: "listing",
        entityId: cleanId(payload.listingId),
        metadata: { listingId: cleanId(payload.listingId) },
      };
    case NotificationType.LISTING_REJECTED:
      return {
        category: categoryFor(payload.eventType),
        title: "لم تتم الموافقة على إعلانك",
        body: cleanText(
          `إعلان «${payload.listingTitle}» يحتاج إلى تعديل.${payload.rejectionReason ? ` السبب: ${cleanText(payload.rejectionReason, 240)}` : ""}`,
          240
        ),
        actionUrl: "/my-listings",
        entityType: "listing",
        entityId: cleanId(payload.listingId),
        metadata: { listingId: cleanId(payload.listingId) },
      };
    case NotificationType.LISTING_EXPIRING:
      return {
        category: categoryFor(payload.eventType),
        title: "إعلانك يقترب من الانتهاء",
        body: cleanText(`إعلان «${payload.listingTitle}» يقترب من انتهاء الصلاحية في ${cleanText(payload.expiresAt, 32)}.`, 240),
        actionUrl: "/my-listings",
        entityType: "listing",
        entityId: cleanId(payload.listingId),
        metadata: { listingId: cleanId(payload.listingId) },
      };
    case NotificationType.LISTING_EXPIRED:
      return {
        category: categoryFor(payload.eventType),
        title: "انتهت صلاحية إعلانك",
        body: cleanText(`انتهت صلاحية إعلان «${payload.listingTitle}». يمكنك تجديده من إعلاناتي.`, 240),
        actionUrl: "/my-listings",
        entityType: "listing",
        entityId: cleanId(payload.listingId),
        metadata: { listingId: cleanId(payload.listingId) },
      };
    case NotificationType.LISTING_FAVORITED_AGGREGATE: {
      const count = requireIntegerInRange(payload.favoriteCount, 1, Number.MAX_SAFE_INTEGER, "favoriteCount");
      return {
        category: categoryFor(payload.eventType),
        title: "إعجاب جديد بإعلانك",
        body: cleanText(`حصل إعلان «${payload.listingTitle}» على ${count} إعجاباً.`, 240),
        actionUrl: listingUrl(payload.listingId),
        entityType: "listing",
        entityId: cleanId(payload.listingId),
        metadata: { listingId: cleanId(payload.listingId), favoriteCount: count },
      };
    }
    case NotificationType.REVIEW_RECEIVED: {
      const rating = requireIntegerInRange(payload.rating, 1, 5, "rating");
      return {
        category: categoryFor(payload.eventType),
        title: "تلقيت تقييماً جديداً",
        body: cleanText(`قيّمك ${payload.reviewerName} بـ ${rating} من 5 بخصوص «${payload.listingTitle}».`, 240),
        actionUrl: "/me",
        entityType: "review",
        entityId: cleanId(payload.reviewId),
        metadata: {
          listingId: cleanId(payload.listingId),
          rating,
          reviewerId: cleanId(payload.reviewerId),
        },
      };
    }
    case NotificationType.SAVED_SEARCH_MATCHES: {
      const totalCount = requireIntegerInRange(payload.totalCount, 1, Number.MAX_SAFE_INTEGER, "totalCount");
      const matchingListingIds = payload.matchingListingIds.slice(0, 10).map(cleanId).filter(Boolean);
      return {
        category: categoryFor(payload.eventType),
        title: "نتائج جديدة لبحثك المحفوظ",
        body: cleanText(`وجدنا ${totalCount} نتيجة جديدة لبحث «${payload.savedSearchName}».`, 240),
        actionUrl: canonicalSavedSearchUrl(payload.query),
        entityType: "savedSearch",
        entityId: cleanId(payload.savedSearchId),
        metadata: {
          savedSearchId: cleanId(payload.savedSearchId),
          savedSearchName: cleanText(payload.savedSearchName, 80),
          matchingListingIds,
          totalCount,
        },
      };
    }
    case NotificationType.SYSTEM_ANNOUNCEMENT:
      return {
        category: categoryFor(payload.eventType),
        title: cleanText(payload.title, 100),
        body: cleanText(payload.body, 240),
        actionUrl: assertInternalActionUrl(payload.actionUrl),
        entityType: "announcement",
        entityId: cleanId(payload.announcementId),
        metadata: { announcementId: cleanId(payload.announcementId) },
      };
    case NotificationType.SECURITY_ALERT:
      return {
        category: categoryFor(payload.eventType),
        title: "تنبيه أمني للحساب",
        body: "لاحظنا نشاطاً أمنياً يحتاج إلى مراجعة. تحقق من إعدادات حسابك.",
        actionUrl: "/me/settings",
        entityType: "securityAlert",
        entityId: cleanId(payload.alertId),
        metadata: { alertId: cleanId(payload.alertId) },
      };
    default:
      return assertNever(payload);
  }
}

export function renderNotification(type: NotificationType, payload: NotificationEventPayload): RenderedNotification {
  const rendered = render(type, payload);
  return {
    ...rendered,
    title: cleanText(rendered.title, 100),
    body: cleanText(rendered.body, 240),
    actionUrl: assertInternalActionUrl(rendered.actionUrl),
  };
}
