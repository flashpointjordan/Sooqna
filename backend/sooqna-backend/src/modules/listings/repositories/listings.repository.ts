import * as path from "node:path";
import { env } from "../../../config/env";
import { prisma } from "../../../config/prisma";
import { parseIso, toIso } from "../../../shared/utils/dates";
import { buildListingSearchText, normalizeArabic } from "../../../shared/utils/arabic";
import { withMarketplaceJsonLock } from "../../../shared/database/marketplaceJsonLock";
import { readJsonArrayFile, writeJsonArrayFileAtomically } from "../../../utils/fileStore";
import type { Listing } from "../listings.types";

export type PaginationOptions = {
  limit?: number;
  offset?: number;
  category?: string;
  city?: string;
  search?: string;
  sort?: "newest" | "price_asc" | "price_desc";
  priceMin?: number;
  priceMax?: number;
};

export interface ListingsRepository {
  create(listing: Listing): Promise<Listing>;
  list(pagination?: PaginationOptions): Promise<{ items: Listing[]; total: number }>;
  listByOwner(ownerId: string): Promise<Listing[]>;
  findById(id: string): Promise<Listing | null>;
  findByIds(ids: string[]): Promise<Listing[]>;
  findByIdIncludingDeleted(id: string): Promise<Listing | null>;
  findByClientRequestId(ownerId: string, clientRequestId: string): Promise<Listing | null>;
  update(id: string, listing: Listing): Promise<Listing>;
  updateFields(id: string, fields: Partial<Record<string, unknown>>): Promise<Listing>;
  addImage(listingId: string, image: { url: string; path: string; isPrimary: boolean; order: number }): Promise<void>;
  removeImage(listingId: string, imageId: string): Promise<void>;
  countImages(listingId: string): Promise<number>;
}

const listingsDataPath = path.resolve(
  process.cwd(),
  "src/modules/listings/repositories/listings.data.json"
);

function useJsonFallback(): boolean {
  return env.enableCategoriesJsonFallback;
}

type ListingWithImages = Awaited<ReturnType<typeof prisma.listing.findFirst>> & {
  listingImages?: Array<{ id: string; url: string; path: string; isPrimary: boolean; order: number }>;
};

function mapListing(record: ListingWithImages): Listing {
  if (!record) {
    throw new Error("Listing not found.");
  }
  const listing = record;
  return {
    id: listing.id,
    title: listing.title,
    titleLower: listing.titleLower,
    clientRequestId: listing.clientRequestId ?? null,
    description: listing.description,
    price: listing.price,
    currency: listing.currency as Listing["currency"],
    priceType: listing.priceType as Listing["priceType"],
    categoryId: listing.categoryId,
    ownerId: listing.ownerId ?? "",
    ownerSnapshot: {
      fullName: listing.ownerSnapshotName,
      photoURL: listing.ownerSnapshotPhotoUrl,
    },
    location: {
      country: listing.locationCountry,
      city: listing.locationCity,
      area: listing.locationArea,
    },
    images: (listing.listingImages ?? []).map((img) => ({
      url: img.url,
      path: img.path,
      isPrimary: img.isPrimary,
      order: img.order,
    })),
    status: listing.status as Listing["status"],
    condition: listing.condition as Listing["condition"],
    contactPreference: listing.contactPreference as Listing["contactPreference"],
    viewsCount: listing.viewsCount,
    favoritesCount: listing.favoritesCount,
    messagesCount: listing.messagesCount,
    isFeatured: listing.isFeatured,
    isApproved: listing.isApproved,
    publishedAt: toIso(listing.publishedAt),
    soldAt: toIso(listing.soldAt),
    archivedAt: toIso(listing.archivedAt),
    expiresAt: toIso(listing.expiresAt),
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
    deletedAt: toIso(listing.deletedAt),
  };
}

const INCLUDE_IMAGES = { listingImages: { orderBy: { order: "asc" as const } } };

export class PrismaListingsRepository implements ListingsRepository {
  async create(listing: Listing): Promise<Listing> {
    try {
      const created = await prisma.listing.create({
        data: {
          id: listing.id,
          title: listing.title,
          titleLower: listing.titleLower,
          searchText: buildListingSearchText(listing.title, listing.description),
          clientRequestId: listing.clientRequestId ?? null,
          description: listing.description,
          price: listing.price,
          currency: listing.currency,
          priceType: listing.priceType,
          categoryId: listing.categoryId,
          ownerId: listing.ownerId,
          ownerSnapshotName: listing.ownerSnapshot.fullName,
          ownerSnapshotPhotoUrl: listing.ownerSnapshot.photoURL,
          locationCountry: listing.location.country,
          locationCity: listing.location.city,
          locationArea: listing.location.area,
          status: listing.status,
          condition: listing.condition,
          contactPreference: listing.contactPreference,
          viewsCount: listing.viewsCount,
          favoritesCount: listing.favoritesCount,
          messagesCount: listing.messagesCount,
          isFeatured: listing.isFeatured,
          isApproved: listing.isApproved,
          publishedAt: parseIso(listing.publishedAt),
          soldAt: parseIso(listing.soldAt),
          archivedAt: parseIso(listing.archivedAt),
          expiresAt: parseIso(listing.expiresAt),
          createdAt: new Date(listing.createdAt),
          updatedAt: new Date(listing.updatedAt),
          deletedAt: parseIso(listing.deletedAt),
          listingImages: {
            create: listing.images.map((image) => ({
              url: image.url,
              path: image.path,
              isPrimary: image.isPrimary,
              order: image.order,
            })),
          },
        },
        include: INCLUDE_IMAGES,
      });
      return mapListing(created);
    } catch (error) {
      if (useJsonFallback()) {
        return withMarketplaceJsonLock(async () => {
          const listings = readJsonArrayFile<Listing>(listingsDataPath);
          listings.push(listing);
          writeJsonArrayFileAtomically(listingsDataPath, listings);
          return listing;
        });
      }
      throw new Error("Failed to create listing.", { cause: error });
    }
  }

  async list(pagination?: PaginationOptions): Promise<{ items: Listing[]; total: number }> {
    const limit = Math.min(pagination?.limit ?? 20, 100);
    const offset = pagination?.offset ?? 0;
    const category = pagination?.category?.trim().toLowerCase() ?? "";
    const city = pagination?.city?.trim().toLowerCase() ?? "";
    const search = pagination?.search?.trim().toLowerCase() ?? "";
    const sort = pagination?.sort ?? "newest";
    const priceMin = pagination?.priceMin;
    const priceMax = pagination?.priceMax;

    const priceFilter: Record<string, unknown> = {};
    if (typeof priceMin === "number" && Number.isFinite(priceMin)) priceFilter.gte = priceMin;
    if (typeof priceMax === "number" && Number.isFinite(priceMax)) priceFilter.lte = priceMax;

    const where = {
      deletedAt: null,
      status: "published",
      ...(category ? { categoryId: { equals: category } } : {}),
      ...(city ? { locationCity: { equals: city, mode: "insensitive" as const } } : {}),
      ...(Object.keys(priceFilter).length > 0 ? { price: priceFilter } : {}),
      AND: [
        {
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        ...(search
          ? [
              {
                OR: [
                  // Arabic-normalized match (alef/yaa/taa/diacritic-insensitive).
                  { searchText: { contains: normalizeArabic(search) } },
                  // Raw fallbacks keep behavior for rows not yet backfilled.
                  { title: { contains: search, mode: "insensitive" as const } },
                  { description: { contains: search, mode: "insensitive" as const } },
                ],
              },
            ]
          : []),
      ],
    };
    const orderBy: Array<{ isFeatured?: "asc" | "desc"; price?: "asc" | "desc"; createdAt?: "asc" | "desc"; id?: "asc" | "desc" }> =
      sort === "price_asc"
        ? [{ isFeatured: "desc" }, { price: "asc" }, { createdAt: "desc" }, { id: "desc" }]
        : sort === "price_desc"
          ? [{ isFeatured: "desc" }, { price: "desc" }, { createdAt: "desc" }, { id: "desc" }]
          : [{ isFeatured: "desc" }, { createdAt: "desc" }, { id: "desc" }];

    try {
      const [listings, total] = await prisma.$transaction([
        prisma.listing.findMany({
          where,
          orderBy,
          include: INCLUDE_IMAGES,
          take: limit,
          skip: offset,
        }),
        prisma.listing.count({ where }),
      ]);
      return { items: listings.map(mapListing), total };
    } catch (error) {
      if (useJsonFallback()) {
        const all = readJsonArrayFile<Listing>(listingsDataPath);
        const nowMs = Date.now();
        let filtered = all.filter((listing) => {
          if (listing.deletedAt !== null) return false;
          if (listing.status !== "published") return false;
          if (!listing.expiresAt) return true;
          return new Date(listing.expiresAt).getTime() > nowMs;
        });
        if (category) {
          filtered = filtered.filter((listing) => listing.categoryId.toLowerCase() === category);
        }
        if (city) {
          filtered = filtered.filter((listing) => listing.location.city.toLowerCase() === city);
        }
        if (search) {
          const nsearch = normalizeArabic(search);
          filtered = filtered.filter((listing) => {
            const haystack = normalizeArabic(`${listing.title} ${listing.description}`);
            return (
              haystack.includes(nsearch) ||
              listing.title.toLowerCase().includes(search) ||
              listing.description.toLowerCase().includes(search)
            );
          });
        }
        if (typeof priceMin === "number") {
          filtered = filtered.filter((listing) => listing.price >= priceMin);
        }
        if (typeof priceMax === "number") {
          filtered = filtered.filter((listing) => listing.price <= priceMax);
        }
        if (sort === "price_asc") {
          filtered = [...filtered].sort((a, b) => Number(b.isFeatured) - Number(a.isFeatured) || a.price - b.price);
        } else if (sort === "price_desc") {
          filtered = [...filtered].sort((a, b) => Number(b.isFeatured) - Number(a.isFeatured) || b.price - a.price);
        } else {
          filtered = [...filtered].sort((a, b) => Number(b.isFeatured) - Number(a.isFeatured) || b.createdAt.localeCompare(a.createdAt));
        }
        return { items: filtered.slice(offset, offset + limit), total: filtered.length };
      }
      throw new Error("Failed to list listings.", { cause: error });
    }
  }

  async listByOwner(ownerId: string): Promise<Listing[]> {
    try {
      const listings = await prisma.listing.findMany({
        where: { deletedAt: null, ownerId },
        orderBy: { createdAt: "desc" },
        include: INCLUDE_IMAGES,
      });
      return listings.map(mapListing);
    } catch (error) {
      if (useJsonFallback()) {
        const listings = readJsonArrayFile<Listing>(listingsDataPath);
        return listings
          .filter((listing) => listing.deletedAt === null && listing.ownerId === ownerId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }
      throw new Error("Failed to list owner listings.", { cause: error });
    }
  }

  async findById(id: string): Promise<Listing | null> {
    try {
      const listing = await prisma.listing.findFirst({
        where: { id, deletedAt: null },
        include: INCLUDE_IMAGES,
      });
      return listing ? mapListing(listing) : null;
    } catch (error) {
      if (useJsonFallback()) {
        const listings = readJsonArrayFile<Listing>(listingsDataPath);
        const listing = listings.find((item) => item.id === id && item.deletedAt === null);
        return listing ?? null;
      }
      throw new Error("Failed to fetch listing.", { cause: error });
    }
  }

  async findByIds(ids: string[]): Promise<Listing[]> {
    if (!ids.length) return [];
    try {
      const listings = await prisma.listing.findMany({
        where: { id: { in: ids }, deletedAt: null },
        include: INCLUDE_IMAGES,
      });
      return listings.map(mapListing);
    } catch (error) {
      if (useJsonFallback()) {
        const all = readJsonArrayFile<Listing>(listingsDataPath);
        const idSet = new Set(ids);
        return all.filter((item) => idSet.has(item.id) && item.deletedAt === null);
      }
      throw new Error("Failed to fetch listings by IDs.", { cause: error });
    }
  }

  async findByIdIncludingDeleted(id: string): Promise<Listing | null> {
    try {
      const listing = await prisma.listing.findFirst({
        where: { id },
        include: INCLUDE_IMAGES,
      });
      return listing ? mapListing(listing) : null;
    } catch (error) {
      if (useJsonFallback()) {
        const listings = readJsonArrayFile<Listing>(listingsDataPath);
        return listings.find((item) => item.id === id) ?? null;
      }
      throw new Error("Failed to fetch listing.", { cause: error });
    }
  }

  async findByClientRequestId(ownerId: string, clientRequestId: string): Promise<Listing | null> {
    try {
      const listing = await prisma.listing.findFirst({
        where: { ownerId, clientRequestId, deletedAt: null },
        include: INCLUDE_IMAGES,
      });
      return listing ? mapListing(listing) : null;
    } catch (error) {
      if (useJsonFallback()) {
        const listings = readJsonArrayFile<Listing>(listingsDataPath);
        return (
          listings.find(
            (item) =>
              item.ownerId === ownerId &&
              item.clientRequestId === clientRequestId &&
              item.deletedAt === null
          ) ?? null
        );
      }
      throw new Error("Failed to fetch listing by client request id.", { cause: error });
    }
  }

  async updateFields(id: string, fields: Partial<Record<string, unknown>>): Promise<Listing> {
    try {
      const updated = await prisma.listing.update({
        where: { id },
        data: fields as Record<string, unknown>,
        include: INCLUDE_IMAGES,
      });
      return mapListing(updated);
    } catch (error) {
      if (useJsonFallback()) {
        return withMarketplaceJsonLock(async () => {
          const listings = readJsonArrayFile<Listing>(listingsDataPath);
          const idx = listings.findIndex((item) => item.id === id);
          if (idx < 0) throw new Error("Listing not found.");
          Object.assign(listings[idx], fields);
          writeJsonArrayFileAtomically(listingsDataPath, listings);
          return listings[idx];
        });
      }
      throw new Error("Listing not found.", { cause: error });
    }
  }

  async update(id: string, listing: Listing): Promise<Listing> {
    try {
      await prisma.listingImage.deleteMany({ where: { listingId: id } });
      const updated = await prisma.listing.update({
        where: { id },
        data: {
          title: listing.title,
          titleLower: listing.titleLower,
          searchText: buildListingSearchText(listing.title, listing.description),
          clientRequestId: listing.clientRequestId ?? null,
          description: listing.description,
          price: listing.price,
          currency: listing.currency,
          priceType: listing.priceType,
          categoryId: listing.categoryId,
          ownerId: listing.ownerId,
          ownerSnapshotName: listing.ownerSnapshot.fullName,
          ownerSnapshotPhotoUrl: listing.ownerSnapshot.photoURL,
          locationCountry: listing.location.country,
          locationCity: listing.location.city,
          locationArea: listing.location.area,
          status: listing.status,
          condition: listing.condition,
          contactPreference: listing.contactPreference,
          viewsCount: listing.viewsCount,
          favoritesCount: listing.favoritesCount,
          messagesCount: listing.messagesCount,
          isFeatured: listing.isFeatured,
          isApproved: listing.isApproved,
          publishedAt: parseIso(listing.publishedAt),
          soldAt: parseIso(listing.soldAt),
          archivedAt: parseIso(listing.archivedAt),
          expiresAt: parseIso(listing.expiresAt),
          createdAt: new Date(listing.createdAt),
          updatedAt: new Date(listing.updatedAt),
          deletedAt: parseIso(listing.deletedAt),
          listingImages: {
            create: listing.images.map((image) => ({
              url: image.url,
              path: image.path,
              isPrimary: image.isPrimary,
              order: image.order,
            })),
          },
        },
        include: INCLUDE_IMAGES,
      });
      return mapListing(updated);
    } catch (error) {
      if (useJsonFallback()) {
        return withMarketplaceJsonLock(async () => {
          const listings = readJsonArrayFile<Listing>(listingsDataPath);
          const idx = listings.findIndex((item) => item.id === id);
          if (idx < 0) throw new Error("Listing not found.");
          listings[idx] = listing;
          writeJsonArrayFileAtomically(listingsDataPath, listings);
          return listing;
        });
      }
      throw new Error("Listing not found.", { cause: error });
    }
  }

  async addImage(listingId: string, image: { url: string; path: string; isPrimary: boolean; order: number }): Promise<void> {
    try {
      await prisma.listingImage.create({
        data: {
          listingId,
          url: image.url,
          path: image.path,
          isPrimary: image.isPrimary,
          order: image.order,
        },
      });
    } catch (error) {
      throw new Error("Failed to add image.", { cause: error });
    }
  }

  async removeImage(listingId: string, imageId: string): Promise<void> {
    try {
      await prisma.listingImage.deleteMany({
        where: { id: imageId, listingId },
      });
    } catch (error) {
      throw new Error("Failed to remove image.", { cause: error });
    }
  }

  async countImages(listingId: string): Promise<number> {
    try {
      return await prisma.listingImage.count({ where: { listingId } });
    } catch {
      return 0;
    }
  }
}
