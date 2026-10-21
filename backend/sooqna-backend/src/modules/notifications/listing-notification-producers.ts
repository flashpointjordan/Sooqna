import type { Prisma } from "@prisma/client";
import { enqueueNotificationEvent } from "./notifications.producer";
import { matchesSavedSearch, savedSearchAggregationKey } from "./saved-search-matcher";

export async function enqueueSavedSearchMatchesForListing(tx: Prisma.TransactionClient, listing: { id: string; ownerId: string; title: string; description: string; price: number; categoryId: string; condition: string; status: string; location: { city: string } }, eventCreatedAt: Date): Promise<number> {
  const searches = await tx.savedSearch.findMany({ select: { id: true, userId: true, name: true, query: true } });
  let matched = 0;
  for (const search of searches) {
    const query = (search.query && typeof search.query === "object" && !Array.isArray(search.query) ? search.query : {}) as Record<string, unknown>;
    if (!matchesSavedSearch(listing, query, search.userId)) continue;
    matched += 1;
    const matchingListingIds = [listing.id].slice(0, 10);
    await enqueueNotificationEvent({
      payload: { eventType: "SAVED_SEARCH_MATCHES", recipientId: search.userId, savedSearchId: search.id, savedSearchName: search.name, query, matchingListingIds, totalCount: 1 },
      aggregateType: "savedSearch", aggregateId: search.id, recipientId: search.userId,
      dedupeKey: `saved-search:${search.id}:${listing.id}`,
      aggregationKey: savedSearchAggregationKey(search.id, eventCreatedAt),
    }, tx);
  }
  return matched;
}
