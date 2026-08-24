import { NotificationCategory, NotificationType } from "@prisma/client";
import { AppError } from "../../shared/errors/appError";
import {
  adminNotificationBroadcastBodySchema,
  notificationIdParamsSchema,
  notificationListQuerySchema,
  notificationPreferencesUpdateBodySchema,
} from "./notifications.schemas";
import {
  assertInternalActionUrl,
  renderNotification,
} from "./notifications.templates";
import {
  decodeNotificationCursor,
  encodeNotificationCursor,
  type NotificationEventPayload,
} from "./notifications.types";

const payloads = {
  MESSAGE_RECEIVED: {
    eventType: NotificationType.MESSAGE_RECEIVED,
    recipientId: "recipient-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    senderId: "sender-1",
    senderName: "  أحمد\nالمُرسِل ",
    listingId: "listing-1",
    listingTitle: "  دراجة   هوائية ",
    messagePreview: "  أهلاً بك\nهذه معاينة خاصة للرسالة.  ",
  },
  LISTING_APPROVED: {
    eventType: NotificationType.LISTING_APPROVED,
    recipientId: "recipient-1",
    listingId: "listing-2",
    listingTitle: "سيارة اقتصادية",
  },
  LISTING_REJECTED: {
    eventType: NotificationType.LISTING_REJECTED,
    recipientId: "recipient-1",
    listingId: "listing-3",
    listingTitle: "هاتف مستعمل",
    rejectionReason: "يرجى إضافة صور أوضح للمنتج.",
  },
  LISTING_EXPIRING: {
    eventType: NotificationType.LISTING_EXPIRING,
    recipientId: "recipient-1",
    listingId: "listing-4",
    listingTitle: "طاولة خشبية",
    expiresAt: "2026-09-01T12:00:00.000Z",
  },
  LISTING_EXPIRED: {
    eventType: NotificationType.LISTING_EXPIRED,
    recipientId: "recipient-1",
    listingId: "listing-5",
    listingTitle: "غسالة منزلية",
  },
  LISTING_FAVORITED_AGGREGATE: {
    eventType: NotificationType.LISTING_FAVORITED_AGGREGATE,
    recipientId: "recipient-1",
    listingId: "listing-6",
    listingTitle: "كاميرا رقمية",
    favoriteCount: 3,
  },
  REVIEW_RECEIVED: {
    eventType: NotificationType.REVIEW_RECEIVED,
    recipientId: "recipient-1",
    reviewId: "review-1",
    reviewerId: "reviewer-1",
    reviewerName: "سارة",
    listingId: "listing-7",
    listingTitle: "جهاز لوحي",
    rating: 5,
  },
  SAVED_SEARCH_MATCHES: {
    eventType: NotificationType.SAVED_SEARCH_MATCHES,
    recipientId: "recipient-1",
    savedSearchId: "search-1",
    savedSearchName: "شقق دمشق",
    query: { q: "cars", city: "damascus", category: "real-estate", maxPrice: 500 },
    matchingListingIds: ["listing-8", "listing-9"],
    totalCount: 2,
  },
  SYSTEM_ANNOUNCEMENT: {
    eventType: NotificationType.SYSTEM_ANNOUNCEMENT,
    recipientId: "recipient-1",
    announcementId: "announcement-1",
    title: "تحديث الخدمة",
    body: "سيجري تحديث قصير للخدمة مساءً.",
    actionUrl: "/notifications?tab=system",
  },
  SECURITY_ALERT: {
    eventType: NotificationType.SECURITY_ALERT,
    recipientId: "recipient-1",
    alertId: "alert-1",
  },
} satisfies Record<NotificationType, NotificationEventPayload>;

const expected = {
  MESSAGE_RECEIVED: {
    category: NotificationCategory.MESSAGES,
    entityType: "conversation",
    entityId: "conversation-1",
    actionUrl: "/messages?conversation=conversation-1",
  },
  LISTING_APPROVED: {
    category: NotificationCategory.LISTINGS,
    entityType: "listing",
    entityId: "listing-2",
    actionUrl: "/listings/listing-2",
  },
  LISTING_REJECTED: {
    category: NotificationCategory.LISTINGS,
    entityType: "listing",
    entityId: "listing-3",
    actionUrl: "/my-listings",
  },
  LISTING_EXPIRING: {
    category: NotificationCategory.LISTINGS,
    entityType: "listing",
    entityId: "listing-4",
    actionUrl: "/my-listings",
  },
  LISTING_EXPIRED: {
    category: NotificationCategory.LISTINGS,
    entityType: "listing",
    entityId: "listing-5",
    actionUrl: "/my-listings",
  },
  LISTING_FAVORITED_AGGREGATE: {
    category: NotificationCategory.ENGAGEMENT,
    entityType: "listing",
    entityId: "listing-6",
    actionUrl: "/listings/listing-6",
  },
  REVIEW_RECEIVED: {
    category: NotificationCategory.ENGAGEMENT,
    entityType: "review",
    entityId: "review-1",
    actionUrl: "/me",
  },
  SAVED_SEARCH_MATCHES: {
    category: NotificationCategory.SAVED_SEARCHES,
    entityType: "savedSearch",
    entityId: "search-1",
    actionUrl: "/listings?search=cars&category=real-estate&city=damascus&maxPrice=500",
  },
  SYSTEM_ANNOUNCEMENT: {
    category: NotificationCategory.SYSTEM,
    entityType: "announcement",
    entityId: "announcement-1",
    actionUrl: "/notifications?tab=system",
  },
  SECURITY_ALERT: {
    category: NotificationCategory.SECURITY,
    entityType: "securityAlert",
    entityId: "alert-1",
    actionUrl: "/me/settings",
  },
} satisfies Record<NotificationType, {
  category: NotificationCategory;
  entityType: string;
  entityId: string;
  actionUrl: string;
}>;

function codePoints(value: string): number {
  return Array.from(value).length;
}

function expectValidationError(action: () => unknown): void {
  expect(action).toThrow(AppError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
  }
}

describe("notification rendering contracts", () => {
  it("renders every Prisma notification type with its intended category, entity, and safe action", () => {
    expect(Object.values(NotificationType).sort()).toEqual(Object.keys(payloads).sort());

    for (const type of Object.values(NotificationType)) {
      const rendered = renderNotification(type, payloads[type]);
      expect(rendered.title).not.toHaveLength(0);
      expect(rendered.body).not.toHaveLength(0);
      expect(codePoints(rendered.title)).toBeLessThanOrEqual(100);
      expect(codePoints(rendered.body)).toBeLessThanOrEqual(240);
      expect(rendered).toMatchObject(expected[type]);
      expect(assertInternalActionUrl(rendered.actionUrl)).toBe(rendered.actionUrl);
    }
  });

  it("sanitizes message context, caps Unicode code points, and keeps private text out of metadata", () => {
    const safePreview = "🙂".repeat(130);
    const privateSuffix = "PRIVATE_SECRET token=abc@example.com";
    const unsafePayload = {
      ...payloads.MESSAGE_RECEIVED,
      senderName: "  أحمد\u0000\nالمرسل ",
      listingTitle: "  دراجة\tهوائية ",
      messagePreview: `${safePreview}${privateSuffix}`,
      password: "not-for-notification-metadata",
      unknownField: "never-rendered",
    };
    const rendered = renderNotification(NotificationType.MESSAGE_RECEIVED, unsafePayload);

    expect(rendered.body).not.toMatch(/[\u0000\n\t]/);
    expect(rendered.title).toContain("أحمد المرسل");
    expect(rendered.body).toBe(`بخصوص دراجة هوائية: ${"🙂".repeat(120)}`);
    expect(codePoints(rendered.body)).toBe(codePoints("بخصوص دراجة هوائية: ") + 120);
    expect(rendered.body).not.toContain("PRIVATE_SECRET");
    expect(JSON.stringify(rendered.metadata)).not.toContain("PRIVATE_SECRET");
    expect(JSON.stringify(rendered.metadata)).not.toContain("token=");
    expect(JSON.stringify(rendered.metadata)).not.toContain("@example.com");
    expect(JSON.stringify(rendered.metadata)).not.toContain("password");
    expect(JSON.stringify(rendered.metadata)).not.toContain("unknownField");
    expect(Object.keys(rendered.metadata).sort()).toEqual(["listingId", "messageId", "senderId"]);
  });

  it("caps user-provided copy and saved-search metadata to the allowlisted rendering facts", () => {
    const rejected = renderNotification(NotificationType.LISTING_REJECTED, {
      ...payloads.LISTING_REJECTED,
      rejectionReason: "سبب ".repeat(100),
    });
    const savedSearch = renderNotification(NotificationType.SAVED_SEARCH_MATCHES, {
      ...payloads.SAVED_SEARCH_MATCHES,
      matchingListingIds: Array.from({ length: 12 }, (_, index) => `listing-${index}`),
      totalCount: 12,
    });

    expect(codePoints(rejected.body)).toBeLessThanOrEqual(240);
    expect(savedSearch.metadata).toEqual({
      savedSearchId: "search-1",
      savedSearchName: "شقق دمشق",
      matchingListingIds: Array.from({ length: 10 }, (_, index) => `listing-${index}`),
      totalCount: 12,
    });
  });

  it("maps saved-search q to the public listings search parameter while preserving safe filters", () => {
    const rendered = renderNotification(NotificationType.SAVED_SEARCH_MATCHES, {
      ...payloads.SAVED_SEARCH_MATCHES,
      query: { q: "  used cars  ", city: "damascus", minPrice: 100, condition: "used" },
    });
    const action = new URL(rendered.actionUrl!, "https://sooqna.test");

    expect(action.pathname).toBe("/listings");
    expect(action.searchParams.get("search")).toBe("used cars");
    expect(action.searchParams.get("q")).toBeNull();
    expect(action.searchParams.get("city")).toBe("damascus");
    expect(action.searchParams.get("minPrice")).toBe("100");
    expect(action.searchParams.get("condition")).toBe("used");
  });

  it("uses fixed safe security copy and ignores arbitrary payload text", () => {
    const secret = "token=abc123 email=private@example.com password=do-not-render";
    const unsafeSecurityPayload = {
      ...payloads.SECURITY_ALERT,
      securityText: secret,
      token: secret,
      email: "private@example.com",
      password: "do-not-render",
    };
    const rendered = renderNotification(NotificationType.SECURITY_ALERT, unsafeSecurityPayload);
    const visible = JSON.stringify({ title: rendered.title, body: rendered.body, metadata: rendered.metadata });

    expect(rendered.title).toMatch(/[\u0600-\u06FF]/);
    expect(rendered.body).toMatch(/[\u0600-\u06FF]/);
    expect(visible).not.toContain("token=");
    expect(visible).not.toContain("private@example.com");
    expect(visible).not.toContain("password");
    expect(rendered.metadata).toEqual({ alertId: "alert-1" });
  });

  it("rejects unsafe and non-internal action URLs", () => {
    for (const value of [
      "https://example.com",
      "//example.com",
      "javascript:alert(1)",
      "/\\evil",
      "/safe\nLocation: https://evil.example",
      "/\u0000another-control-character",
    ]) {
      expectValidationError(() => assertInternalActionUrl(value));
    }
    expect(assertInternalActionUrl("")).toBeNull();
    expect(assertInternalActionUrl("/listings?q=test#result")).toBe("/listings?q=test#result");
  });

  it("rejects out-of-range engagement and saved-search counts instead of normalizing them", () => {
    expectValidationError(() => renderNotification(NotificationType.LISTING_FAVORITED_AGGREGATE, {
      ...payloads.LISTING_FAVORITED_AGGREGATE,
      favoriteCount: 0,
    }));
    expectValidationError(() => renderNotification(NotificationType.REVIEW_RECEIVED, {
      ...payloads.REVIEW_RECEIVED,
      rating: 6,
    }));
    expectValidationError(() => renderNotification(NotificationType.SAVED_SEARCH_MATCHES, {
      ...payloads.SAVED_SEARCH_MATCHES,
      totalCount: 0,
    }));
  });
});

describe("notification cursors and request schemas", () => {
  it("round-trips an opaque cursor and rejects malformed cursor input without parser details", () => {
    const encoded = encodeNotificationCursor({ createdAt: "2026-08-24T10:11:12.000Z", id: "notification-1" });
    expect(decodeNotificationCursor(encoded)).toEqual({
      createdAt: "2026-08-24T10:11:12.000Z",
      id: "notification-1",
    });

    for (const cursor of ["not-base64", "e30", "eyJjcmVhdGVkQXQiOiJub3QtYS1kYXRlIiwiaWQiOiJ4In0", "eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTI0VDEwOjExOjEyLjAwMFoiLCJpZCI6IiJ9"]) {
      expectValidationError(() => decodeNotificationCursor(cursor));
    }
  });

  it("coerces bounded list query values and rejects invalid filters", () => {
    expect(notificationListQuerySchema.parse({ limit: "25", unread: "false", category: "LISTINGS" })).toEqual({
      limit: 25,
      unread: false,
      category: NotificationCategory.LISTINGS,
    });
    expect(notificationListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(notificationListQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(notificationListQuerySchema.safeParse({ unread: "1" }).success).toBe(false);
    expect(notificationListQuerySchema.safeParse({ unexpected: "field" }).success).toBe(false);
    expect(notificationIdParamsSchema.safeParse({ id: "x".repeat(129) }).success).toBe(false);
  });

  it("strictly validates manageable preferences and audience-specific broadcasts", () => {
    expect(notificationPreferencesUpdateBodySchema.parse({ MESSAGES: false })).toEqual({ MESSAGES: false });
    expect(notificationPreferencesUpdateBodySchema.safeParse({}).success).toBe(false);
    expect(notificationPreferencesUpdateBodySchema.safeParse({ SYSTEM: false }).success).toBe(false);
    expect(notificationPreferencesUpdateBodySchema.safeParse({ MESSAGES: "false" }).success).toBe(false);

    expect(adminNotificationBroadcastBodySchema.parse({
      title: "صيانة",
      body: "تنبيه خدمة",
      audience: "ROLES",
      audienceValue: { roles: ["BUYER", "SELLER"] },
      actionUrl: "/notifications",
    })).toMatchObject({ audience: "ROLES" });
    expect(adminNotificationBroadcastBodySchema.safeParse({
      title: "صيانة",
      body: "تنبيه خدمة",
      audience: "USERS",
      audienceValue: { roles: ["BUYER"] },
    }).success).toBe(false);
    expect(adminNotificationBroadcastBodySchema.safeParse({
      title: "صيانة",
      body: "تنبيه خدمة",
      audience: "USERS",
      audienceValue: { userIds: Array.from({ length: 101 }, (_, index) => `user-${index}`) },
    }).success).toBe(false);
    expect(adminNotificationBroadcastBodySchema.safeParse({
      title: "صيانة",
      body: "تنبيه خدمة",
      audience: "ALL",
      audienceValue: null,
      actionUrl: "https://evil.example",
    }).success).toBe(false);
  });
});
