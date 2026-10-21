import { CATEGORY_IDS, CITY_IDS } from "../../shared/constants/domain";
import { normalizeArabic } from "../../shared/utils/arabic";

type ListingLike = { id: string; ownerId?: string | null; title?: string; description?: string; price?: number; categoryId?: string; condition?: string; status?: string; deletedAt?: string | Date | null; location?: { city?: string | null } };
type Query = Record<string, unknown>;

const cityAliases: Record<string, string> = { دمشق: "damascus", damascus: "damascus", حلب: "aleppo", aleppo: "aleppo", حمص: "homs", homs: "homs", حماة: "hama", hama: "hama", اللاذقية: "latakia", latakia: "latakia" };

function canonicalCity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = normalizeArabic(value.trim().toLowerCase());
  const resolved = cityAliases[key] ?? key;
  return CITY_IDS.includes(resolved as (typeof CITY_IDS)[number]) ? resolved : undefined;
}

function numberValue(query: Query, ...keys: string[]): number | undefined {
  for (const key of keys) if (typeof query[key] === "number" && Number.isFinite(query[key])) return query[key] as number;
  return undefined;
}

export function matchesSavedSearch(listing: ListingLike, query: Query, recipientId?: string): boolean {
  if (recipientId && listing.ownerId === recipientId) return false;
  if (listing.deletedAt || listing.status !== "published") return false;
  const city = canonicalCity(query.city);
  if (city && canonicalCity(listing.location?.city) !== city) return false;
  const category = typeof query.category === "string" ? query.category.trim().toLowerCase() : undefined;
  if (category && CATEGORY_IDS.includes(category as (typeof CATEGORY_IDS)[number]) && listing.categoryId !== category) return false;
  const min = numberValue(query, "priceMin", "minPrice");
  const max = numberValue(query, "priceMax", "maxPrice");
  if (min !== undefined && (listing.price ?? 0) < min) return false;
  if (max !== undefined && (listing.price ?? 0) > max) return false;
  if (typeof query.condition === "string" && query.condition.trim() && listing.condition !== query.condition.trim()) return false;
  if (typeof query.q === "string" && query.q.trim()) {
    const haystack = normalizeArabic(`${listing.title ?? ""} ${listing.description ?? ""}`);
    if (!haystack.includes(normalizeArabic(query.q.trim()))) return false;
  }
  return true;
}

export function savedSearchAggregationKey(savedSearchId: string, eventCreatedAt: Date): string {
  return `${savedSearchId}:${eventCreatedAt.toISOString().slice(0, 13)}`;
}
