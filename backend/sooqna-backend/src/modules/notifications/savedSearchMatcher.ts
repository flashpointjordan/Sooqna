import type { Prisma } from "@prisma/client";
import { buildListingSearchText, normalizeArabic } from "../../shared/utils/arabic";
import { enqueueNotificationEvent } from "./notifications.producer";
import type { SavedSearchQueryFacts } from "./notifications.types";

export type PublishedListingFacts = {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  locationCity: string;
  condition: string;
  price: number;
  ownerId: string | null;
  publishedAt: Date;
};

type SavedSearchRow = { id: string; userId: string; name: string; query: unknown };
type MatcherTransaction = {
  savedSearch: { findMany(args: unknown): Promise<SavedSearchRow[]> };
  notificationOutbox: Prisma.TransactionClient["notificationOutbox"];
};

export function canonicalSavedSearchQuery(value: unknown): SavedSearchQueryFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const output: SavedSearchQueryFacts = {};
  const text = (key: string) => typeof input[key] === "string" ? input[key].trim().slice(0, 120) : "";
  const q = text("q") || text("search");
  const category = text("category").toLowerCase();
  const city = text("city");
  const condition = text("condition").toLowerCase();
  const sort = text("sort").toLowerCase();
  if (q) output.q = q;
  if (category) output.category = category;
  if (city) output.city = city;
  if (condition === "new" || condition === "used") output.condition = condition;
  if (sort === "newest" || sort === "price_asc" || sort === "price_desc") output.sort = sort;
  const min = finiteNumber(input.priceMin) ?? finiteNumber(input.minPrice);
  const max = finiteNumber(input.priceMax) ?? finiteNumber(input.maxPrice);
  if (min !== undefined && min >= 0) output.priceMin = min;
  if (max !== undefined && max >= 0) output.priceMax = max;
  return output;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function matchesSavedSearch(listing: PublishedListingFacts, rawQuery: unknown): boolean {
  const query = canonicalSavedSearchQuery(rawQuery);
  if (query.q && !buildListingSearchText(listing.title, listing.description).includes(normalizeArabic(query.q))) return false;
  if (query.category && listing.categoryId.trim().toLowerCase() !== query.category) return false;
  if (query.city && normalizeArabic(listing.locationCity) !== normalizeArabic(query.city)) return false;
  if (query.condition && listing.condition.toLowerCase() !== query.condition) return false;
  if (query.priceMin !== undefined && listing.price < query.priceMin) return false;
  if (query.priceMax !== undefined && listing.price > query.priceMax) return false;
  return true;
}

export async function enqueueSavedSearchMatchesForListing(
  listing: PublishedListingFacts,
  tx: MatcherTransaction,
  options: { pageSize?: number } = {}
): Promise<number> {
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 100, 200));
  const publishedAt = listing.publishedAt.toISOString();
  const hour = publishedAt.slice(0, 13);
  let cursor: string | undefined;
  let matched = 0;
  for (;;) {
    const page = await tx.savedSearch.findMany({
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, userId: true, name: true, query: true },
    });
    for (const savedSearch of page) {
      if (!matchesSavedSearch(listing, savedSearch.query)) continue;
      const query = canonicalSavedSearchQuery(savedSearch.query);
      await enqueueNotificationEvent({
        aggregateType: "savedSearch",
        aggregateId: savedSearch.id,
        recipientId: savedSearch.userId,
        dedupeKey: `saved-search:${savedSearch.id}:${listing.id}:${publishedAt}`,
        aggregationKey: `saved-search:${savedSearch.userId}:${savedSearch.id}:${hour}`,
        payload: {
          eventType: "SAVED_SEARCH_MATCHES",
          recipientId: savedSearch.userId,
          savedSearchId: savedSearch.id,
          savedSearchName: savedSearch.name,
          query,
          matchingListingIds: [listing.id].slice(0, 10),
          totalCount: 1,
        },
      }, tx as unknown as Prisma.TransactionClient);
      matched += 1;
    }
    if (page.length < pageSize) break;
    cursor = page.at(-1)?.id;
    if (!cursor) break;
  }
  return matched;
}
