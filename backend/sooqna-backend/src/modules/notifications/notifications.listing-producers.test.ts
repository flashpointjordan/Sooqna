import { NotificationOutboxState } from "@prisma/client";
import {
  moderationNotification,
  parseRejectionReason,
  runListingLifecycle,
} from "./listingNotificationProducers";
import {
  enqueueSavedSearchMatchesForListing,
  matchesSavedSearch,
} from "./savedSearchMatcher";

function outbox() {
  return { upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => create) };
}

describe("listing notification producers", () => {
  test("validates and sanitizes a rejection reason", () => {
    expect(parseRejectionReason("  Policy\u0000   violation  ")).toBe("Policy violation");
    expect(() => parseRejectionReason("   ")).toThrow("Rejection reason is required");
    expect(() => parseRejectionReason("x".repeat(501))).toThrow("500 characters");
  });

  test("builds only publish and reject moderation facts from authoritative listing data", () => {
    const listing = { id: "listing-1", ownerId: "owner-1", title: "Trusted title" };
    const at = new Date("2026-09-12T08:15:00.000Z");
    expect(moderationNotification("publish", listing, at)).toMatchObject({
      dedupeKey: "listing-approved:listing-1:2026-09-12T08:15:00.000Z",
      payload: { eventType: "LISTING_APPROVED", recipientId: "owner-1", listingTitle: "Trusted title" },
    });
    expect(moderationNotification("reject", listing, at, "Unsafe\u0000  reason")).toMatchObject({
      dedupeKey: "listing-rejected:listing-1:2026-09-12T08:15:00.000Z",
      payload: { eventType: "LISTING_REJECTED", rejectionReason: "Unsafe reason" },
    });
    expect(moderationNotification("archive", listing, at)).toBeNull();
    expect(moderationNotification("sold", listing, at)).toBeNull();
    expect(moderationNotification("feature", listing, at)).toBeNull();
  });

  test("emits expiring once per UTC day and expired only for a successful state transition", async () => {
    const notificationOutbox = outbox();
    const warning = { id: "warning", ownerId: "u1", title: "Soon", status: "published", expiresAt: new Date("2026-09-14T10:00:00.000Z") };
    const expired = { id: "expired", ownerId: "u2", title: "Gone", status: "published", expiresAt: new Date("2026-09-12T07:00:00.000Z") };
    const tx = {
      listing: {
        findMany: jest.fn().mockResolvedValueOnce([warning, expired]).mockResolvedValueOnce([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      notificationOutbox,
      $transaction: jest.fn(),
    };
    tx.$transaction.mockImplementation(async (work: (inner: typeof tx) => unknown) => work(tx));

    await runListingLifecycle(tx as never, new Date("2026-09-12T08:00:00.000Z"), { pageSize: 20, warningDays: 3 });

    expect(notificationOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "listing-expiring:warning:2026-09-12" },
      create: expect.objectContaining({ eventType: "LISTING_EXPIRING", state: NotificationOutboxState.PENDING }),
    }));
    expect(notificationOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "listing-expired:expired:2026-09-12T07:00:00.000Z" },
    }));
    expect(tx.listing.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "expired", status: "published" }),
      data: expect.objectContaining({ status: "archived" }),
    }));

    notificationOutbox.upsert.mockClear();
    tx.listing.findMany.mockReset().mockResolvedValueOnce([expired]).mockResolvedValueOnce([]);
    tx.listing.updateMany.mockResolvedValue({ count: 0 });
    await runListingLifecycle(tx as never, new Date("2026-09-12T09:00:00.000Z"));
    expect(notificationOutbox.upsert).not.toHaveBeenCalled();
  });

  test("matches saved searches with canonical Arabic and listing filter normalization", () => {
    const listing = {
      id: "listing-1", title: "شقة للإيجار", description: "قرب الجامعة", categoryId: "homes",
      locationCity: "عمّان", condition: "used", price: 250, ownerId: "seller", publishedAt: new Date("2026-09-12T08:00:00.000Z"),
    };
    expect(matchesSavedSearch(listing, { q: "شقه", city: "عمان", category: "HOMES", priceMin: 200, maxPrice: 300, condition: "used" })).toBe(true);
    expect(matchesSavedSearch(listing, { q: "سيارة" })).toBe(false);
    expect(matchesSavedSearch(listing, { minPrice: 300 })).toBe(false);
  });

  test("pages saved searches and emits hourly aggregate facts with bounded ids", async () => {
    const notificationOutbox = outbox();
    const firstPage = Array.from({ length: 2 }, (_, index) => ({ id: `search-${index + 1}`, userId: `user-${index + 1}`, name: `Search ${index + 1}`, query: { city: "Amman" } }));
    const tx = {
      savedSearch: { findMany: jest.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce([]) },
      notificationOutbox,
    };
    const listing = { id: "listing-1", title: "Laptop", description: "Fast", categoryId: "electronics", locationCity: "Amman", condition: "used", price: 100, ownerId: "seller", publishedAt: new Date("2026-09-12T08:15:00.000Z") };

    const matched = await enqueueSavedSearchMatchesForListing(listing, tx as never, { pageSize: 2 });

    expect(matched).toBe(2);
    expect(tx.savedSearch.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: { id: "search-2" }, skip: 1, take: 2 }));
    expect(notificationOutbox.upsert).toHaveBeenCalledTimes(2);
    expect(notificationOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "saved-search:search-1:listing-1:2026-09-12T08:15:00.000Z" },
      create: expect.objectContaining({
        payload: expect.objectContaining({ matchingListingIds: ["listing-1"], totalCount: 1, _aggregationKey: "saved-search:user-1:search-1:2026-09-12T08" }),
      }),
    }));
  });
});
