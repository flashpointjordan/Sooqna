import { matchesSavedSearch, savedSearchAggregationKey } from "./saved-search-matcher";

describe("saved-search matcher", () => {
  const listing = {
    id: "listing-1", ownerId: "owner-1", title: "شقة دمشق", titleLower: "شقة دمشق",
    description: "", price: 100, categoryId: "real-estate", location: { city: "damascus", country: "", area: "" },
    condition: "used", status: "published", deletedAt: null,
  } as any;

  it("uses canonical city and price aliases and excludes the owner", () => {
    expect(matchesSavedSearch(listing, { city: "دمشق", minPrice: 50, maxPrice: 150 }, "buyer")).toBe(true);
    expect(matchesSavedSearch(listing, { city: "damascus" }, "owner-1")).toBe(false);
  });

  it("creates a deterministic UTC-hour aggregation key from publication time", () => {
    expect(savedSearchAggregationKey("search-1", new Date("2026-08-24T10:42:00.000Z"))).toBe("search-1:2026-08-24T10");
  });

  it("keeps owner exclusion stable for matching listings", () => {
    expect(matchesSavedSearch(listing, { q: "شقة" }, "owner-1")).toBe(false);
    expect(matchesSavedSearch(listing, { q: "شقة" }, "buyer-1")).toBe(true);
  });
});
