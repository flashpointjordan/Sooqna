import { generateId } from "../../utils/ids";
import { nowIso } from "../../utils/time";
import { buildListingSearchText } from "../../shared/utils/arabic";
import { AppError } from "../../shared/errors/appError";
import { env } from "../../config/env";
import { CATEGORY_IDS } from "../../shared/constants/domain";
import { resolveCityId } from "../../shared/utils/city";
import { PrismaUsersRepository } from "../users/repositories/users.repository";
import { trackEngagementEvent } from "../engagement/engagement.service";
import type { ListingsRepository, PaginationOptions } from "./repositories/listings.repository";
import type { Listing, ListingCurrency } from "./listings.types";

type CreateListingInput = {
  ownerId: string;
  ownerFullName: string;
  ownerPhotoURL: string;
  title: string;
  price: number;
  currency?: ListingCurrency;
  categoryId: string;
  description?: string;
  clientRequestId?: string;
  location?: {
    country?: string;
    city?: string;
    area?: string;
  };
};

type CreateListingUserInput = {
  uid: string;
  email: string;
  fullName: string;
  photoURL: string;
};

type AttachImageInput = {
  listingId: string;
  ownerId: string;
  url: string;
  path: string;
};

const MAX_IMAGES_PER_LISTING = 10;

export class ListingsService {
  private readonly usersRepo = new PrismaUsersRepository();
  private resolveCityId(input?: string | null): string | undefined {
    return resolveCityId(input);
  }

  constructor(private readonly repo: ListingsRepository) {}

  private async ensureOwnerUser(owner: CreateListingUserInput): Promise<void> {
    const existing = await this.usersRepo.findByUid(owner.uid);
    if (existing) return;
    const now = nowIso();
    await this.usersRepo.upsert({
      uid: owner.uid,
      fullName: owner.fullName,
      email: owner.email,
      photoURL: owner.photoURL,
      role: "SELLER",
      accountStatus: "active",
      isEmailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  async create(input: CreateListingInput): Promise<Listing> {
    if (!input.title.trim()) throw new AppError(400, "title is required", "VALIDATION_ERROR");
    if (!Number.isFinite(input.price) || input.price < 0)
      throw new AppError(400, "price must be non-negative", "VALIDATION_ERROR");
    if (!input.categoryId.trim())
      throw new AppError(400, "categoryId is required", "VALIDATION_ERROR");
    await this.ensureOwnerUser({
      uid: input.ownerId,
      email: "",
      fullName: input.ownerFullName,
      photoURL: input.ownerPhotoURL,
    });
    const clientRequestId = input.clientRequestId?.trim() || null;
    if (clientRequestId) {
      const existing = await this.repo.findByClientRequestId(input.ownerId, clientRequestId);
      if (existing) {
        return existing;
      }
    }

    const now = nowIso();
    const listing: Listing = {
      id: generateId("lst"),
      title: input.title.trim(),
      titleLower: input.title.trim().toLowerCase(),
      clientRequestId,
      description: input.description?.trim() ?? "",
      price: input.price,
      currency: input.currency ?? "SYP",
      priceType: "fixed",
      categoryId: input.categoryId.trim(),
      ownerId: input.ownerId,
      ownerSnapshot: {
        fullName: input.ownerFullName,
        photoURL: input.ownerPhotoURL,
      },
      location: {
        country: input.location?.country ?? "",
        // Store the canonical city id (e.g. "damascus") so listings are
        // filterable; fall back to the trimmed raw value when unknown.
        city: this.resolveCityId(input.location?.city) ?? input.location?.city?.trim() ?? "",
        area: input.location?.area ?? "",
      },
      images: [],
      status: "draft",
      condition: "used",
      contactPreference: "chat",
      viewsCount: 0,
      favoritesCount: 0,
      messagesCount: 0,
      isFeatured: false,
      isApproved: false,
      publishedAt: null,
      soldAt: null,
      archivedAt: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    try {
      return await this.repo.create(listing);
    } catch (error) {
      if (clientRequestId) {
        const existing = await this.repo.findByClientRequestId(input.ownerId, clientRequestId);
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  async list(pagination?: PaginationOptions): Promise<{ items: Listing[]; total: number }> {
    const normalized = this.normalizeFilters(pagination);
    const result = await this.repo.list(normalized);
    return result;
  }

  async listForOwner(ownerId: string): Promise<Listing[]> {
    if (!ownerId.trim()) {
      throw new AppError(400, "ownerId is required", "VALIDATION_ERROR");
    }
    return this.repo.listByOwner(ownerId);
  }

  async getById(id: string): Promise<Listing | null> {
    return this.repo.findById(id);
  }

  async findByIds(ids: string[]): Promise<Listing[]> {
    return this.repo.findByIds(ids);
  }

  async findPublicByIds(ids: string[]): Promise<Listing[]> {
    const listings = await this.repo.findByIds(ids);
    return listings.filter((listing) => {
      this.applyAutoExpiration(listing);
      if (listing.status !== "published") return false;
      if (listing.expiresAt && new Date(listing.expiresAt).getTime() <= Date.now()) return false;
      return true;
    });
  }

  async getPublicById(id: string): Promise<Listing | null> {
    const listing = await this.repo.findById(id);
    if (!listing) return null;
    this.applyAutoExpiration(listing);
    if (listing.status !== "published") return null;
    if (listing.expiresAt && new Date(listing.expiresAt).getTime() <= Date.now()) return null;
    return listing;
  }

  async getByIdForOwner(id: string, ownerId: string): Promise<Listing | null> {
    const listing = await this.repo.findById(id);
    if (!listing) return null;
    if (listing.ownerId !== ownerId) return null;
    return listing;
  }

  async recordView(listingId: string, viewerId?: string): Promise<Listing | null> {
    const listing = await this.repo.findById(listingId);
    if (!listing) return null;

    this.applyAutoExpiration(listing);

    if (listing.status !== "published") {
      if (viewerId && listing.ownerId === viewerId) return listing;
      return null;
    }

    if (listing.expiresAt && new Date(listing.expiresAt).getTime() <= Date.now()) {
      if (viewerId && listing.ownerId === viewerId) return listing;
      return null;
    }

    const isOwnerView = viewerId === listing.ownerId;
    if (!isOwnerView) {
      // View counting and analytics are non-critical: a failure here must not turn a
      // public listing read into a 500. Fall back to the already-loaded listing.
      try {
        const updated = await this.repo.updateFields(listingId, {
          viewsCount: listing.viewsCount + 1,
          updatedAt: new Date(),
        });
        await trackEngagementEvent({
          eventType: "view",
          listingId,
          actorId: viewerId,
        });
        return updated;
      } catch {
        return listing;
      }
    }

    return listing;
  }

  async patch(
    listingId: string,
    userId: string,
    patch: Partial<Pick<Listing, "title" | "description" | "price">>
  ): Promise<Listing> {
    const existing = await this.repo.findById(listingId);
    if (!existing) throw new AppError(404, "Listing not found", "NOT_FOUND");
    if (existing.ownerId !== userId) throw new AppError(403, "Forbidden", "FORBIDDEN");
    this.applyAutoExpiration(existing);
    if (existing.status === "sold" || existing.status === "rejected") {
      throw new AppError(400, "Listing cannot be edited in current status.", "LISTING_STATE_INVALID");
    }

    const fields: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title?.trim()) {
      fields.title = patch.title.trim();
      fields.titleLower = patch.title.trim().toLowerCase();
    }
    if (patch.description !== undefined) {
      fields.description = patch.description;
    }
    if (fields.title !== undefined || fields.description !== undefined) {
      const nextTitle = typeof fields.title === "string" ? fields.title : existing.title;
      const nextDescription =
        typeof fields.description === "string" ? fields.description : existing.description;
      fields.searchText = buildListingSearchText(nextTitle, nextDescription);
    }
    if (patch.price !== undefined && Number.isFinite(patch.price) && patch.price >= 0) {
      fields.price = patch.price;
    }
    return this.repo.updateFields(existing.id, fields);
  }

  async softDelete(listingId: string, userId: string): Promise<Listing> {
    const existing = await this.repo.findById(listingId);
    if (!existing) throw new AppError(404, "Listing not found", "NOT_FOUND");
    if (existing.ownerId !== userId) throw new AppError(403, "Forbidden", "FORBIDDEN");

    return this.repo.updateFields(existing.id, {
      deletedAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async attachImage(input: AttachImageInput): Promise<Listing> {
    const listing = await this.repo.findById(input.listingId);
    if (!listing) throw new AppError(404, "Listing not found", "NOT_FOUND");
    if (listing.ownerId !== input.ownerId) throw new AppError(403, "Forbidden", "FORBIDDEN");
    this.applyAutoExpiration(listing);
    if (listing.status === "sold" || listing.status === "rejected") {
      throw new AppError(
        400,
        "Listing images cannot be updated in current status.",
        "LISTING_STATE_INVALID"
      );
    }
    if (!input.path.replace(/\\/g, "/").startsWith(`uploads/listings/${input.ownerId}/`)) {
      throw new AppError(400, "Image path is not owned by this user.", "VALIDATION_ERROR");
    }
    if (!input.url.startsWith(`${env.uploadsPublicBaseUrl.replace(/\/$/, "")}/listings/${input.ownerId}/`)) {
      throw new AppError(400, "Image URL is not a trusted listing upload.", "VALIDATION_ERROR");
    }
    if (listing.images.length >= MAX_IMAGES_PER_LISTING) {
      throw new AppError(400, "Maximum listing image count reached.", "VALIDATION_ERROR");
    }

    const isPrimary = listing.images.length === 0;
    const order = listing.images.length + 1;

    await this.repo.addImage(input.listingId, {
      url: input.url,
      path: input.path,
      isPrimary,
      order,
    });

    const updated = await this.repo.findById(input.listingId);
    return updated!;
  }

  async publish(listingId: string, ownerId: string): Promise<Listing> {
    const listing = await this.getOwnerListingOrThrow(listingId, ownerId);
    this.applyAutoExpiration(listing);
    if (listing.status === "published") {
      throw new AppError(400, "Listing is already published.", "LISTING_STATE_INVALID");
    }
    if (listing.status === "sold" || listing.status === "rejected") {
      throw new AppError(400, "Listing cannot be published in current status.", "LISTING_STATE_INVALID");
    }
    if (listing.images.length === 0) {
      throw new AppError(400, "At least one image is required before publishing.", "VALIDATION_ERROR");
    }

    const now = new Date();
    return this.repo.updateFields(listing.id, {
      status: "pending",
      isApproved: false,
      publishedAt: null,
      archivedAt: null,
      expiresAt: null,
      updatedAt: now,
    });
  }

  async unpublish(listingId: string, ownerId: string): Promise<Listing> {
    const listing = await this.getOwnerListingOrThrow(listingId, ownerId);
    this.applyAutoExpiration(listing);
    if (listing.status !== "published") {
      throw new AppError(400, "Only published listings can be unpublished.", "LISTING_STATE_INVALID");
    }
    const now = new Date();
    return this.repo.updateFields(listing.id, {
      status: "archived",
      archivedAt: now,
      updatedAt: now,
    });
  }

  async archive(listingId: string, ownerId: string): Promise<Listing> {
    const listing = await this.getOwnerListingOrThrow(listingId, ownerId);
    this.applyAutoExpiration(listing);
    if (listing.status !== "published" && listing.status !== "draft") {
      throw new AppError(400, "Only published or draft listings can be archived.", "LISTING_STATE_INVALID");
    }
    const now = new Date();
    return this.repo.updateFields(listing.id, {
      status: "archived",
      archivedAt: now,
      updatedAt: now,
    });
  }

  async markSold(listingId: string, ownerId: string): Promise<Listing> {
    const listing = await this.getOwnerListingOrThrow(listingId, ownerId);
    this.applyAutoExpiration(listing);
    if (listing.status !== "published") {
      throw new AppError(400, "Only published listings can be marked as sold.", "LISTING_STATE_INVALID");
    }
    const now = new Date();
    return this.repo.updateFields(listing.id, {
      status: "sold",
      soldAt: now,
      isFeatured: false,
      updatedAt: now,
    });
  }

  async renew(listingId: string, ownerId: string, durationDays?: number): Promise<Listing> {
    const listing = await this.getOwnerListingOrThrow(listingId, ownerId);
    this.applyAutoExpiration(listing);
    if (listing.status !== "archived") {
      throw new AppError(400, "Only archived listings can be renewed.", "LISTING_STATE_INVALID");
    }
    if (listing.images.length === 0) {
      throw new AppError(400, "At least one image is required before publishing.", "VALIDATION_ERROR");
    }
    const effectiveDays =
      typeof durationDays === "number" && durationDays >= 1 && durationDays <= 365
        ? durationDays
        : env.listingRenewDays;
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + effectiveDays);

    return this.repo.updateFields(listing.id, {
      status: "published",
      publishedAt: now,
      expiresAt,
      archivedAt: null,
      updatedAt: now,
    });
  }

  async feature(listingId: string, adminId: string, role: string): Promise<Listing> {
    if (role !== "ADMIN") {
      throw new AppError(403, "Only admins can feature listings.", "FORBIDDEN");
    }
    const listing = await this.repo.findById(listingId);
    if (!listing) throw new AppError(404, "Listing not found", "NOT_FOUND");
    if (listing.status !== "published") {
      throw new AppError(400, "Only published listings can be featured.", "LISTING_STATE_INVALID");
    }
    return this.repo.updateFields(listing.id, {
      isFeatured: true,
      updatedAt: new Date(),
    });
  }

  async unfeature(listingId: string, adminId: string, role: string): Promise<Listing> {
    if (role !== "ADMIN") {
      throw new AppError(403, "Only admins can unfeature listings.", "FORBIDDEN");
    }
    const listing = await this.repo.findById(listingId);
    if (!listing) throw new AppError(404, "Listing not found", "NOT_FOUND");
    return this.repo.updateFields(listing.id, {
      isFeatured: false,
      updatedAt: new Date(),
    });
  }

  async expire(listingId: string, ownerId: string): Promise<Listing> {
    const listing = await this.getOwnerListingOrThrow(listingId, ownerId);
    this.applyAutoExpiration(listing);
    if (listing.status !== "published") {
      throw new AppError(400, "Only published listings can be expired.", "LISTING_STATE_INVALID");
    }
    const now = new Date();
    return this.repo.updateFields(listing.id, {
      status: "archived",
      expiresAt: now,
      archivedAt: now,
      updatedAt: now,
    });
  }

  private async getOwnerListingOrThrow(listingId: string, ownerId: string): Promise<Listing> {
    const listing = await this.repo.findById(listingId);
    if (!listing) throw new AppError(404, "Listing not found", "NOT_FOUND");
    if (listing.ownerId !== ownerId) throw new AppError(403, "Forbidden", "FORBIDDEN");
    return listing;
  }

  private applyAutoExpiration(listing: Listing): void {
    if (listing.status !== "published" || !listing.expiresAt) return;
    if (new Date(listing.expiresAt).getTime() > Date.now()) return;
    listing.status = "archived";
    listing.archivedAt = listing.expiresAt;
    listing.updatedAt = nowIso();
  }

  normalizeFilters(pagination?: PaginationOptions): PaginationOptions {
    const categoryInput = pagination?.category?.trim().toLowerCase() ?? "";
    const category = CATEGORY_IDS.includes(categoryInput as (typeof CATEGORY_IDS)[number])
      ? categoryInput
      : undefined;
    const city = this.resolveCityId(pagination?.city);
    const sort =
      pagination?.sort === "price_asc" || pagination?.sort === "price_desc" || pagination?.sort === "newest"
        ? pagination.sort
        : "newest";

    return {
      limit: pagination?.limit,
      offset: pagination?.offset,
      category,
      city,
      search: pagination?.search?.trim() || undefined,
      sort,
      priceMin: pagination?.priceMin,
      priceMax: pagination?.priceMax,
    };
  }
}
