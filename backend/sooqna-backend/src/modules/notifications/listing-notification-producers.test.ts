import { enqueueSavedSearchMatchesForListing } from "./listing-notification-producers";

jest.mock("./notifications.producer", () => ({ enqueueNotificationEvent: jest.fn().mockResolvedValue({}) }));
import { enqueueNotificationEvent } from "./notifications.producer";

describe("saved-search listing fanout", () => {
  it("pages searches in batches of 200", async () => {
    const findMany = jest.fn()
      .mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => ({ id: `s-${i}`, userId: `u-${i}`, name: "x", query: { city: "دمشق" } })))
      .mockResolvedValueOnce([{ id: "s-200", userId: "u-200", name: "x", query: { city: "دمشق" } }]);
    await enqueueSavedSearchMatchesForListing({ savedSearch: { findMany } } as any, { id: "l-1", ownerId: "owner", title: "x", description: "", price: 1, categoryId: "real-estate", condition: "used", status: "published", location: { city: "damascus" } }, new Date("2026-08-24T10:00:00Z"));
    expect(findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ take: 200, skip: 0 }));
    expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ take: 200, skip: 200 }));
    expect(enqueueNotificationEvent).toHaveBeenCalledTimes(201);
  });
});
