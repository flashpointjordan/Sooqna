import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { adminAuth } from "../../config/firebaseAdmin";
import { resolveFirebaseAdminCredentialMode } from "../../config/firebaseAdminCredentialMode";
import { verifyFirebaseToken } from "../../middleware/verifyFirebaseToken";
import { requireActiveUser, requireCurrentUser } from "../../middleware/authContext";
import { checkRole } from "../../middleware/checkRole";
import { AppError } from "../../shared/errors/appError";
import { generateId } from "../../utils/ids";
import { logAuditEvent } from "../audit/audit.service";
import {
  enqueueModerationNotification,
  parseRejectionReason,
  type ModerationAction,
} from "../notifications/listingNotificationProducers";
import { enqueueSavedSearchMatchesForListing } from "../notifications/savedSearchMatcher";

type PageParams = {
  limit: number;
  offset: number;
};

const LISTING_STATUSES = ["draft", "pending", "published", "rejected", "sold", "archived"] as const;
const REPORT_STATUSES = ["open", "in_review", "resolved", "rejected"] as const;
const ACCOUNT_STATUSES = ["active", "suspended", "deleted"] as const;
const TOP_LISTING_METRICS = ["views", "favorites", "messages"] as const;

export const adminRouter = Router();

adminRouter.use(verifyFirebaseToken, requireCurrentUser, requireActiveUser, checkRole([Role.ADMIN]));

function pageParams(req: Request, max = 100): PageParams {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, max));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return { limit, offset };
}

function stringQuery(req: Request, key: string, max = 200): string | undefined {
  const value = req.query[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  if (typeof value !== "string") return undefined;
  return allowed.includes(value as T[number]) ? (value as T[number]) : undefined;
}

function paginationMeta(total: number, page: PageParams) {
  return {
    total,
    limit: page.limit,
    offset: page.offset,
    hasNextPage: page.offset + page.limit < total,
    hasPreviousPage: page.offset > 0,
  };
}

function actorId(req: Request): string {
  const uid = req.currentUser?.firebaseUid;
  if (!uid) throw new AppError(401, "Unauthorized.", "UNAUTHORIZED");
  return uid;
}

function cleanMetadata(input?: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (/token|secret|password|credential|authorization/i.test(key)) continue;
    output[key] = value;
  }
  return output;
}

function firebaseCredentialMode(): "service-account-file" | "service-account-env" | "application-default" | "not_configured" {
  try {
    return resolveFirebaseAdminCredentialMode(
      {
        projectId: env.firebaseProjectId,
        clientEmail: env.firebaseClientEmail,
        privateKey: env.firebasePrivateKey,
        serviceAccountPath: env.firebaseServiceAccountPath,
      },
      {
        allowApplicationDefaultCredentials: env.firebaseUseApplicationDefaultCredentials || env.nodeEnv !== "production",
      }
    );
  } catch {
    return "not_configured";
  }
}

async function firebaseAuthUserCount(): Promise<{ status: "healthy" | "warning" | "not_configured"; count: number | null; message: string }> {
  const credentialMode = firebaseCredentialMode();
  if (!env.firebaseProjectId) {
    return { status: "not_configured", count: null, message: "Firebase project id is not configured." };
  }
  try {
    const firstPage = await adminAuth.listUsers(1);
    return {
      status: "healthy",
      count: firstPage.pageToken ? null : firstPage.users.length,
      message: firstPage.pageToken ? "Firebase Auth is reachable. More than one user exists." : "Firebase Auth is reachable.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: credentialMode === "application-default" ? "not_configured" : "warning",
      count: null,
      message: credentialMode === "application-default"
        ? "Firebase Admin credentials are not available in this local environment."
        : message.slice(0, 180),
    };
  }
}

function dateQuery(req: Request, key: string): Date | undefined {
  const value = req.query[key];
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function startOfDay(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function hoursBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 36e5));
}

function serializeListing(listing: {
  id: string;
  title: string;
  ownerId: string | null;
  ownerSnapshotName: string;
  categoryId: string;
  locationCity: string;
  status: string;
  isFeatured: boolean;
  isApproved: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { listingImages?: number };
}) {
  return {
    ...listing,
    imageCount: listing._count?.listingImages ?? 0,
    _count: undefined,
    publishedAt: listing.publishedAt?.toISOString() ?? null,
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
  };
}

async function directorySizeBytes(directory: string): Promise<number | null> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return directorySizeBytes(entryPath);
        if (!entry.isFile()) return 0;
        const stat = await fs.stat(entryPath);
        return stat.size;
      })
    );
    return sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
  } catch {
    return null;
  }
}

adminRouter.get("/stats", async (_req, res) => {
  const [
    totalUsers,
    activeUsers,
    suspendedUsers,
    totalListings,
    publishedListings,
    draftListings,
    soldListings,
    archivedOrRejectedListings,
    openReports,
    topCities,
    recentAuditActions,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { accountStatus: "active" } }),
    prisma.user.count({ where: { accountStatus: "suspended" } }),
    prisma.listing.count({ where: { deletedAt: null } }),
    prisma.listing.count({ where: { deletedAt: null, status: "published" } }),
    prisma.listing.count({ where: { deletedAt: null, status: "draft" } }),
    prisma.listing.count({ where: { deletedAt: null, status: "sold" } }),
    prisma.listing.count({ where: { deletedAt: null, status: { in: ["archived", "rejected"] } } }),
    prisma.report.count({ where: { status: "open" } }),
    prisma.listing.groupBy({
      by: ["locationCity"],
      where: { deletedAt: null },
      _count: { _all: true },
      orderBy: { _count: { locationCity: "desc" } },
      take: 6,
    }),
    prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, actorId: true, action: true, targetType: true, targetId: true, createdAt: true },
    }),
  ]);

  res.json({
    success: true,
    data: {
      users: { total: totalUsers, active: activeUsers, suspended: suspendedUsers },
      listings: {
        total: totalListings,
        published: publishedListings,
        draft: draftListings,
        sold: soldListings,
        archivedOrRejected: archivedOrRejectedListings,
      },
      reports: { open: openReports },
      topCities: topCities.map((item) => ({
        city: item.locationCity,
        listingCount: item._count._all,
      })),
      recentAuditActions: recentAuditActions.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      })),
    },
  });
});

adminRouter.get("/analytics", async (_req, res) => {
  const today = startOfDay();
  const tomorrow = addDays(today, 1);
  const weekStart = addDays(today, -6);
  const statusValues = [...LISTING_STATUSES];
  const dayBuckets = Array.from({ length: 14 }, (_, idx) => addDays(today, idx - 13));
  const weekBuckets = Array.from({ length: 8 }, (_, idx) => addDays(today, (idx - 7) * 7));

  const [
    totalListings,
    publishedListings,
    newListingsToday,
    newListingsThisWeek,
    totalUsers,
    newUsersToday,
    newUsersThisWeek,
    listingsByStatus,
    topCategories,
    topCities,
    latestActivities,
    dailyListings,
    dailyUsers,
    weeklyListings,
    weeklyUsers,
  ] = await Promise.all([
    prisma.listing.count({ where: { deletedAt: null } }),
    prisma.listing.count({ where: { deletedAt: null, status: "published" } }),
    prisma.listing.count({ where: { deletedAt: null, createdAt: { gte: today, lt: tomorrow } } }),
    prisma.listing.count({ where: { deletedAt: null, createdAt: { gte: weekStart, lt: tomorrow } } }),
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: today, lt: tomorrow } } }),
    prisma.user.count({ where: { createdAt: { gte: weekStart, lt: tomorrow } } }),
    prisma.listing.groupBy({
      by: ["status"],
      where: { deletedAt: null },
      _count: { _all: true },
    }),
    prisma.listing.groupBy({
      by: ["categoryId"],
      where: { deletedAt: null },
      _count: { _all: true },
      orderBy: { _count: { categoryId: "desc" } },
      take: 8,
    }),
    prisma.listing.groupBy({
      by: ["locationCity"],
      where: { deletedAt: null },
      _count: { _all: true },
      orderBy: { _count: { locationCity: "desc" } },
      take: 8,
    }),
    prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, actorId: true, action: true, targetType: true, targetId: true, createdAt: true },
    }),
    Promise.all(
      dayBuckets.map((day) =>
        prisma.listing.count({
          where: { deletedAt: null, createdAt: { gte: day, lt: addDays(day, 1) } },
        })
      )
    ),
    Promise.all(
      dayBuckets.map((day) =>
        prisma.user.count({
          where: { createdAt: { gte: day, lt: addDays(day, 1) } },
        })
      )
    ),
    Promise.all(
      weekBuckets.map((week) =>
        prisma.listing.count({
          where: { deletedAt: null, createdAt: { gte: week, lt: addDays(week, 7) } },
        })
      )
    ),
    Promise.all(
      weekBuckets.map((week) =>
        prisma.user.count({
          where: { createdAt: { gte: week, lt: addDays(week, 7) } },
        })
      )
    ),
  ]);

  const categoryIds = topCategories.map((item) => item.categoryId);
  const categories = categoryIds.length
    ? await prisma.category.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true, nameAr: true, nameEn: true },
      })
    : [];
  const categoryNames = new Map(categories.map((category) => [category.id, category]));
  const statusCounts = new Map(listingsByStatus.map((item) => [item.status, item._count._all]));

  res.json({
    success: true,
    data: {
      kpis: {
        totalListings,
        publishedListings,
        totalUsers,
        newListingsToday,
        newListingsThisWeek,
        newUsersToday,
        newUsersThisWeek,
        conversionRate: totalListings > 0 ? Math.round((publishedListings / totalListings) * 1000) / 10 : 0,
      },
      listingStatuses: statusValues.map((status) => ({
        status,
        count: statusCounts.get(status) ?? 0,
      })),
      topCategories: topCategories.map((item) => {
        const category = categoryNames.get(item.categoryId);
        return {
          categoryId: item.categoryId,
          nameAr: category?.nameAr ?? item.categoryId,
          nameEn: category?.nameEn ?? item.categoryId,
          listingCount: item._count._all,
        };
      }),
      topCities: topCities.map((item) => ({
        city: item.locationCity,
        listingCount: item._count._all,
      })),
      growth: {
        daily: dayBuckets.map((day, idx) => ({
          date: isoDay(day),
          listings: dailyListings[idx] ?? 0,
          users: dailyUsers[idx] ?? 0,
        })),
        weekly: weekBuckets.map((week, idx) => ({
          weekStart: isoDay(week),
          weekEnd: isoDay(addDays(week, 6)),
          listings: weeklyListings[idx] ?? 0,
          users: weeklyUsers[idx] ?? 0,
        })),
      },
      latestActivities: latestActivities.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      })),
    },
  });
});

adminRouter.get("/analytics/moderation-sla", async (_req, res) => {
  const now = new Date();
  const decisionActions = ["publish", "reject", "archive"];

  const [pendingListings, decisions] = await Promise.all([
    prisma.listing.findMany({
      where: { deletedAt: null, status: "pending" },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 500,
    }),
    prisma.listingModerationLog.findMany({
      where: { action: { in: decisionActions } },
      select: { createdAt: true, listingId: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
  ]);

  const decisionListingIds = [...new Set(decisions.map((decision) => decision.listingId))];
  const decisionListings = decisionListingIds.length
    ? await prisma.listing.findMany({
        where: { id: { in: decisionListingIds } },
        select: { id: true, createdAt: true },
      })
    : [];
  const listingCreatedAt = new Map(decisionListings.map((listing) => [listing.id, listing.createdAt]));
  const decisionHours = decisions
    .map((decision) => {
      const createdAt = listingCreatedAt.get(decision.listingId);
      return createdAt ? hoursBetween(createdAt, decision.createdAt) : null;
    })
    .filter((hours): hours is number => typeof hours === "number");
  const pendingAges = pendingListings.map((listing) => hoursBetween(listing.createdAt, now));

  res.json({
    success: true,
    data: {
      pendingCount: pendingListings.length,
      oldestPendingAgeHours: pendingAges.length ? Math.max(...pendingAges) : 0,
      averageDecisionHours: decisionHours.length
        ? Math.round(decisionHours.reduce((sum, hours) => sum + hours, 0) / decisionHours.length)
        : null,
      pendingAgeBuckets: [
        { label: "0-6h", count: pendingAges.filter((hours) => hours <= 6).length },
        { label: "6-24h", count: pendingAges.filter((hours) => hours > 6 && hours <= 24).length },
        { label: "24h+", count: pendingAges.filter((hours) => hours > 24).length },
      ],
    },
  });
});

adminRouter.get("/analytics/top-listings", async (req, res) => {
  const requestedMetric = oneOf(req.query.metric, TOP_LISTING_METRICS) ?? "views";
  const metricField = {
    views: "viewsCount",
    favorites: "favoritesCount",
    messages: "messagesCount",
  } satisfies Record<(typeof TOP_LISTING_METRICS)[number], keyof Prisma.ListingOrderByWithRelationInput>;
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 10, 25));
  const orderField = metricField[requestedMetric];

  const listings = await prisma.listing.findMany({
    where: { deletedAt: null },
    orderBy: [{ [orderField]: "desc" }, { createdAt: "desc" }] as Prisma.ListingOrderByWithRelationInput[],
    take: limit,
    select: {
      id: true,
      title: true,
      status: true,
      categoryId: true,
      locationCity: true,
      viewsCount: true,
      favoritesCount: true,
      messagesCount: true,
      createdAt: true,
    },
  });

  res.json({
    success: true,
    data: listings.map((listing) => ({
      ...listing,
      createdAt: listing.createdAt.toISOString(),
    })),
  });
});

adminRouter.get("/analytics/user-activity", async (_req, res) => {
  const today = startOfDay();
  const sevenDaysAgo = addDays(today, -6);
  const thirtyDaysAgo = addDays(today, -29);
  const tomorrow = addDays(today, 1);

  const [
    activeUsers7d,
    activeUsers30d,
    newUsers7d,
    usersWithListings7d,
    usersWithMessages7d,
    usersWithFavorites7d,
  ] = await Promise.all([
    prisma.user.count({ where: { lastLoginAt: { gte: sevenDaysAgo, lt: tomorrow } } }),
    prisma.user.count({ where: { lastLoginAt: { gte: thirtyDaysAgo, lt: tomorrow } } }),
    prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo, lt: tomorrow } } }),
    prisma.listing.groupBy({
      by: ["ownerId"],
      where: { deletedAt: null, ownerId: { not: null }, createdAt: { gte: sevenDaysAgo, lt: tomorrow } },
    }),
    prisma.message.groupBy({
      by: ["senderId"],
      where: { deletedAt: null, createdAt: { gte: sevenDaysAgo, lt: tomorrow } },
    }),
    prisma.favorite.groupBy({
      by: ["userId"],
      where: { createdAt: { gte: sevenDaysAgo, lt: tomorrow } },
    }),
  ]);

  res.json({
    success: true,
    data: {
      activeUsers7d,
      activeUsers30d,
      usersWithListings7d: usersWithListings7d.length,
      usersWithMessages7d: usersWithMessages7d.length,
      usersWithFavorites7d: usersWithFavorites7d.length,
      newVsActive: [
        { label: "New users", count: newUsers7d },
        { label: "Active users", count: activeUsers7d },
      ],
    },
  });
});

adminRouter.get("/health", async (_req, res) => {
  const uploadsDirectory = path.resolve(process.cwd(), "uploads");
  const credentialMode = firebaseCredentialMode();
  const [users, listings, categories, cities, uploads, uploadsBytes, dbOk, firebaseAuthCount] = await Promise.all([
    prisma.user.count(),
    prisma.listing.count({ where: { deletedAt: null } }),
    prisma.category.count(),
    prisma.city.count(),
    prisma.upload.count(),
    directorySizeBytes(uploadsDirectory),
    prisma.$queryRawUnsafe("SELECT 1").then(() => true).catch(() => false),
    firebaseAuthUserCount(),
  ]);

  res.json({
    success: true,
    data: {
      api: { status: "healthy", message: "API is responding." },
      database: { status: dbOk ? "healthy" : "error", message: dbOk ? "Database connection is healthy." : "Database check failed." },
      counts: { users, listings, categories, cities, uploads },
      uploads: uploadsBytes === null
        ? { status: "not_configured", bytes: null, message: "Uploads directory was not found." }
        : { status: "healthy", bytes: uploadsBytes, message: "Uploads directory is readable." },
      firebaseAuth: {
        status: firebaseAuthCount.status,
        message: firebaseAuthCount.message,
        projectId: env.firebaseProjectId || null,
        credentialMode,
        authUserCount: firebaseAuthCount.count,
        dbUserCount: users,
      },
      recentErrors: { status: "not_configured", items: [], message: "Application error log aggregation is not configured yet." },
    },
  });
});

adminRouter.get("/users", async (req, res) => {
  const page = pageParams(req);
  const search = stringQuery(req, "search");
  const role = oneOf(req.query.role, ["ADMIN", "BUYER", "SELLER"] as const);
  const status = oneOf(req.query.status, ACCOUNT_STATUSES);
  const dateFrom = dateQuery(req, "dateFrom");
  const dateTo = dateQuery(req, "dateTo");
  const where: Prisma.UserWhereInput = {
    ...(role ? { role } : {}),
    ...(status ? { accountStatus: status } : {}),
    ...(dateFrom || dateTo ? { createdAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } } : {}),
    ...(search
      ? {
          OR: [
            { email: { contains: search, mode: "insensitive" } },
            { name: { contains: search, mode: "insensitive" } },
            { firebaseUid: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: page.limit,
      skip: page.offset,
      select: {
        id: true,
        firebaseUid: true,
        email: true,
        name: true,
        avatarUrl: true,
        role: true,
        accountStatus: true,
        isEmailVerified: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.user.count({ where }),
  ]);
  const listingCounts = items.length
    ? await prisma.listing.groupBy({
        by: ["ownerId"],
        where: { deletedAt: null, ownerId: { in: items.map((user) => user.firebaseUid) } },
        _count: { _all: true },
      })
    : [];
  const countsByOwner = new Map(listingCounts.map((item) => [item.ownerId, item._count._all]));
  res.json({
    success: true,
    data: items.map((user) => ({
      ...user,
      listingCount: countsByOwner.get(user.firebaseUid) ?? 0,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    })),
    pagination: paginationMeta(total, page),
  });
});

adminRouter.patch("/users/:id", async (req, res) => {
  const nextRole = oneOf(req.body?.role, ["ADMIN", "BUYER", "SELLER"] as const);
  const nextStatus = oneOf(req.body?.accountStatus, ACCOUNT_STATUSES);
  if (!nextRole && !nextStatus) {
    throw new AppError(400, "role or accountStatus is required.", "VALIDATION_ERROR");
  }
  const currentUser = await prisma.user.findUnique({
    where: { firebaseUid: req.params.id },
    select: { firebaseUid: true, role: true },
  });
  if (!currentUser) throw new AppError(404, "User not found.", "NOT_FOUND");
  if (currentUser.role === Role.ADMIN && nextRole && nextRole !== Role.ADMIN) {
    const otherAdmins = await prisma.user.count({
      where: { role: Role.ADMIN, firebaseUid: { not: req.params.id } },
    });
    if (otherAdmins === 0) {
      throw new AppError(400, "Cannot remove the last admin account.", "VALIDATION_ERROR");
    }
  }

  const data: Prisma.UserUpdateInput = {
    ...(nextRole ? { role: nextRole } : {}),
    ...(nextStatus ? { accountStatus: nextStatus } : {}),
    updatedAt: new Date(),
  };
  const user = await prisma.user.update({
    where: { firebaseUid: req.params.id },
    data,
    select: {
      id: true,
      firebaseUid: true,
      email: true,
      name: true,
      role: true,
      accountStatus: true,
      isEmailVerified: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  await logAuditEvent({
    actorId: actorId(req),
    action: "admin.user.update",
    targetType: "user",
    targetId: user.firebaseUid,
    metadata: cleanMetadata({ role: nextRole ?? null, accountStatus: nextStatus ?? null }),
  });
  res.json({
    success: true,
    data: {
      ...user,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
  });
});

adminRouter.get("/users/:id/details", async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { firebaseUid: req.params.id },
    select: {
      id: true,
      firebaseUid: true,
      email: true,
      name: true,
      avatarUrl: true,
      role: true,
      accountStatus: true,
      isEmailVerified: true,
      totalSold: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!user) throw new AppError(404, "User not found.", "NOT_FOUND");
  const [listingCount, recentListings, recentActivity] = await Promise.all([
    prisma.listing.count({ where: { deletedAt: null, ownerId: user.firebaseUid } }),
    prisma.listing.findMany({
      where: { deletedAt: null, ownerId: user.firebaseUid },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        title: true,
        ownerId: true,
        ownerSnapshotName: true,
        categoryId: true,
        locationCity: true,
        status: true,
        isFeatured: true,
        isApproved: true,
        publishedAt: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { listingImages: true } },
      },
    }),
    prisma.auditLog.findMany({
      where: { actorId: user.firebaseUid },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, actorId: true, action: true, targetType: true, targetId: true, metadata: true, createdAt: true },
    }),
  ]);

  res.json({
    success: true,
    data: {
      user: {
        ...user,
        listingCount,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
      },
      recentListings: recentListings.map(serializeListing),
      recentActivity: recentActivity.map((log) => ({
        ...log,
        metadata: cleanMetadata(log.metadata as Record<string, unknown>),
        createdAt: log.createdAt.toISOString(),
      })),
    },
  });
});

adminRouter.get("/listings", async (req, res) => {
  const page = pageParams(req);
  const status = oneOf(req.query.status, LISTING_STATUSES);
  const category = stringQuery(req, "category", 120);
  const city = stringQuery(req, "city", 120);
  const search = stringQuery(req, "search");
  const dateFrom = dateQuery(req, "dateFrom");
  const dateTo = dateQuery(req, "dateTo");
  const featured = req.query.featured === "true" ? true : req.query.featured === "false" ? false : undefined;
  const where: Prisma.ListingWhereInput = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(category ? { categoryId: category } : {}),
    ...(city ? { locationCity: { equals: city, mode: "insensitive" } } : {}),
    ...(dateFrom || dateTo ? { createdAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } } : {}),
    ...(featured !== undefined ? { isFeatured: featured } : {}),
    ...(search
      ? {
          OR: [
            { id: { contains: search, mode: "insensitive" } },
            { title: { contains: search, mode: "insensitive" } },
            { ownerSnapshotName: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.listing.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: page.limit,
      skip: page.offset,
      select: {
        id: true,
        title: true,
        ownerId: true,
        ownerSnapshotName: true,
        categoryId: true,
        locationCity: true,
        status: true,
        isFeatured: true,
        isApproved: true,
        publishedAt: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { listingImages: true } },
      },
    }),
    prisma.listing.count({ where }),
  ]);
  res.json({
    success: true,
    data: items.map(serializeListing),
    pagination: paginationMeta(total, page),
  });
});

async function moderateListing(req: Request, res: Response, action: ModerationAction) {
  const now = new Date();
  const reason = action === "reject" ? parseRejectionReason(req.body?.reason) : undefined;
  const dataByAction: Record<typeof action, Prisma.ListingUpdateInput> = {
    publish: { status: "published", isApproved: true, publishedAt: now, archivedAt: null, updatedAt: now },
    reject: { status: "rejected", isApproved: false, isFeatured: false, updatedAt: now },
    archive: { status: "archived", isFeatured: false, archivedAt: now, updatedAt: now },
    sold: { status: "sold", isFeatured: false, soldAt: now, updatedAt: now },
    feature: { isFeatured: true, updatedAt: now },
    unfeature: { isFeatured: false, updatedAt: now },
  };
  const listing = await prisma.$transaction(async (tx) => {
    const previous = await tx.listing.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, status: true, ownerId: true, title: true, description: true,
        categoryId: true, locationCity: true, condition: true, price: true,
      },
    });
    if (!previous) throw new AppError(404, "Listing not found.", "NOT_FOUND");
    const updated = await tx.listing.update({
      where: { id: req.params.id },
      data: dataByAction[action],
      select: {
        id: true, title: true, description: true, ownerId: true, categoryId: true,
        locationCity: true, condition: true, price: true, status: true, isFeatured: true,
        isApproved: true, publishedAt: true, archivedAt: true, soldAt: true, updatedAt: true,
      },
    });
    await tx.listingModerationLog.create({
      data: {
        id: generateId("mlog"), listingId: updated.id, adminUserId: actorId(req), action,
        reason: reason ?? null, previousStatus: previous.status, newStatus: updated.status, createdAt: now,
      },
    });
    const eventAt = action === "publish" ? updated.publishedAt : updated.updatedAt;
    if (eventAt) await enqueueModerationNotification(action, updated, eventAt, reason, tx);
    if (action === "publish" && updated.publishedAt) {
      await enqueueSavedSearchMatchesForListing({
        id: updated.id, title: updated.title, description: updated.description,
        categoryId: updated.categoryId, locationCity: updated.locationCity,
        condition: updated.condition, price: updated.price, ownerId: updated.ownerId,
        publishedAt: updated.publishedAt,
      }, tx);
    }
    return updated;
  });
  await logAuditEvent({
    actorId: actorId(req),
    action: `admin.listing.${action}`,
    targetType: "listing",
    targetId: listing.id,
    metadata: cleanMetadata({ reason: reason ?? null, status: listing.status, isFeatured: listing.isFeatured }),
  });
  res.json({
    success: true,
    data: {
      ...listing,
      publishedAt: listing.publishedAt?.toISOString() ?? null,
      archivedAt: listing.archivedAt?.toISOString() ?? null,
      soldAt: listing.soldAt?.toISOString() ?? null,
      updatedAt: listing.updatedAt.toISOString(),
    },
  });
}

adminRouter.post("/listings/:id/publish", (req, res) => void moderateListing(req, res, "publish"));
adminRouter.post("/listings/:id/reject", (req, res) => void moderateListing(req, res, "reject"));
adminRouter.post("/listings/:id/archive", (req, res) => void moderateListing(req, res, "archive"));
adminRouter.post("/listings/:id/sold", (req, res) => void moderateListing(req, res, "sold"));
adminRouter.post("/listings/:id/feature", (req, res) => void moderateListing(req, res, "feature"));
adminRouter.post("/listings/:id/unfeature", (req, res) => void moderateListing(req, res, "unfeature"));

adminRouter.post("/moderation/listings/bulk", async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0).slice(0, 100)
    : [];
  const action = oneOf(req.body?.action, ["publish", "reject", "archive"] as const);
  if (!ids.length || !action) throw new AppError(400, "ids and action are required.", "VALIDATION_ERROR");
  const reason = action === "reject" ? parseRejectionReason(req.body?.reason) : undefined;

  const now = new Date();
  const adminUserId = actorId(req);
  const newStatus = action === "publish" ? "published" : action === "reject" ? "rejected" : "archived";
  const updateData: Prisma.ListingUpdateManyMutationInput = {
    status: newStatus,
    isApproved: action === "publish",
    updatedAt: now,
  };
  if (action === "publish") {
    updateData.publishedAt = now;
    updateData.archivedAt = null;
  } else {
    updateData.isFeatured = false;
  }
  if (action === "archive") {
    updateData.archivedAt = now;
  }
  const updatedCount = await prisma.$transaction(async (tx) => {
    const previousListings = await tx.listing.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: {
        id: true, status: true, ownerId: true, title: true, description: true,
        categoryId: true, locationCity: true, condition: true, price: true,
      },
    });
    if (!previousListings.length) throw new AppError(404, "No listings found.", "NOT_FOUND");
    await tx.listing.updateMany({
      where: { id: { in: previousListings.map((listing) => listing.id) }, deletedAt: null },
      data: updateData,
    });
    await tx.listingModerationLog.createMany({
      data: previousListings.map((listing) => ({
        id: generateId("mlog"),
        listingId: listing.id,
        adminUserId,
        action,
        reason: reason ?? null,
        previousStatus: listing.status,
        newStatus,
        createdAt: now,
      })),
    });
    for (const listing of previousListings) {
      await enqueueModerationNotification(action, listing, now, reason, tx);
      if (action === "publish") {
        await enqueueSavedSearchMatchesForListing({
          id: listing.id, title: listing.title, description: listing.description,
          categoryId: listing.categoryId, locationCity: listing.locationCity,
          condition: listing.condition, price: listing.price, ownerId: listing.ownerId,
          publishedAt: now,
        }, tx);
      }
    }
    return previousListings.length;
  });
  await logAuditEvent({
    actorId: adminUserId,
    action: "admin.listing.bulk",
    targetType: "listing",
    targetId: null,
    metadata: cleanMetadata({ action, count: updatedCount, reason: reason ?? null }),
  });
  res.json({ success: true, data: { updatedCount } });
});

adminRouter.get("/moderation/listings/:id/history", async (req, res) => {
  const logs = await prisma.listingModerationLog.findMany({
    where: { listingId: req.params.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json({
    success: true,
    data: logs.map((log) => ({
      ...log,
      createdAt: log.createdAt.toISOString(),
    })),
  });
});

adminRouter.get("/reports", async (req, res) => {
  const page = pageParams(req);
  const status = oneOf(req.query.status, REPORT_STATUSES);
  const targetType = oneOf(req.query.targetType, ["listing", "message", "user"] as const);
  const reasonCode = stringQuery(req, "reason", 80);
  const where: Prisma.ReportWhereInput = {
    ...(status ? { status } : {}),
    ...(targetType ? { targetType } : {}),
    ...(reasonCode ? { reasonCode } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.report.findMany({ where, orderBy: { createdAt: "desc" }, take: page.limit, skip: page.offset }),
    prisma.report.count({ where }),
  ]);
  res.json({
    success: true,
    data: items.map((report) => ({
      ...report,
      createdAt: report.createdAt.toISOString(),
      updatedAt: report.updatedAt.toISOString(),
    })),
    pagination: paginationMeta(total, page),
  });
});

adminRouter.patch("/reports/:id", async (req, res) => {
  const status = oneOf(req.body?.status, REPORT_STATUSES);
  if (!status) throw new AppError(400, "Valid status is required.", "VALIDATION_ERROR");
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : null;
  const report = await prisma.report.update({
    where: { id: req.params.id },
    data: { status, moderatorId: actorId(req), moderatorNote: note, updatedAt: new Date() },
  });
  await logAuditEvent({
    actorId: actorId(req),
    action: "admin.report.update",
    targetType: report.targetType,
    targetId: report.targetId,
    metadata: cleanMetadata({ reportId: report.id, status, note }),
  });
  res.json({
    success: true,
    data: { ...report, createdAt: report.createdAt.toISOString(), updatedAt: report.updatedAt.toISOString() },
  });
});

adminRouter.get("/categories", async (_req, res) => {
  const categories = await prisma.category.findMany({ orderBy: { sortOrder: "asc" } });
  res.json({
    success: true,
    data: categories.map((category) => ({
      ...category,
      name: { ar: category.nameAr, en: category.nameEn },
      createdAt: category.createdAt?.toISOString() ?? null,
      updatedAt: category.updatedAt?.toISOString() ?? null,
    })),
  });
});

function cityResponse(city: {
  id: string;
  nameAr: string;
  nameEn: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}, listingCount = 0) {
  return {
    ...city,
    listingCount,
    createdAt: city.createdAt?.toISOString() ?? null,
    updatedAt: city.updatedAt?.toISOString() ?? null,
  };
}

adminRouter.get("/cities", async (_req, res) => {
  const cities = await prisma.city.findMany({
    orderBy: [{ sortOrder: "asc" }, { nameAr: "asc" }],
  });
  const grouped = await prisma.listing.groupBy({
    by: ["locationCity"],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const counts = new Map(grouped.map((item) => [item.locationCity.toLowerCase(), item._count._all]));
  res.json({
    success: true,
    data: cities.map((city) => cityResponse(
      city,
      counts.get(city.id.toLowerCase()) ??
        counts.get(city.slug.toLowerCase()) ??
        counts.get(city.nameAr.toLowerCase()) ??
        counts.get(city.nameEn.toLowerCase()) ??
        0
    )),
  });
});

adminRouter.post("/cities", async (req, res) => {
  const id = String(req.body?.id ?? req.body?.slug ?? "").trim().toLowerCase().slice(0, 120);
  const slug = String(req.body?.slug ?? id).trim().toLowerCase().slice(0, 120);
  const nameAr = String(req.body?.nameAr ?? "").trim().slice(0, 120);
  const nameEn = String(req.body?.nameEn ?? "").trim().slice(0, 120);
  if (!id || !slug || !nameAr || !nameEn) {
    throw new AppError(400, "id, slug, nameAr and nameEn are required.", "VALIDATION_ERROR");
  }
  const now = new Date();
  const city = await prisma.city.create({
    data: {
      id,
      slug,
      nameAr,
      nameEn,
      isActive: req.body?.isActive !== false,
      sortOrder: Number.isInteger(req.body?.sortOrder) ? req.body.sortOrder : 0,
      createdAt: now,
      updatedAt: now,
    },
  });
  await logAuditEvent({
    actorId: actorId(req),
    action: "admin.city.create",
    targetType: "city",
    targetId: city.id,
    metadata: cleanMetadata({ slug: city.slug }),
  });
  res.status(201).json({ success: true, data: cityResponse(city) });
});

adminRouter.patch("/cities/:id", async (req, res) => {
  const data: Prisma.CityUpdateInput = { updatedAt: new Date() };
  if (typeof req.body?.nameAr === "string") data.nameAr = req.body.nameAr.trim().slice(0, 120);
  if (typeof req.body?.nameEn === "string") data.nameEn = req.body.nameEn.trim().slice(0, 120);
  if (typeof req.body?.slug === "string") data.slug = req.body.slug.trim().toLowerCase().slice(0, 120);
  if (typeof req.body?.isActive === "boolean") data.isActive = req.body.isActive;
  if (Number.isInteger(req.body?.sortOrder)) data.sortOrder = req.body.sortOrder;
  const city = await prisma.city.update({ where: { id: req.params.id }, data });
  await logAuditEvent({
    actorId: actorId(req),
    action: "admin.city.update",
    targetType: "city",
    targetId: city.id,
    metadata: cleanMetadata({ slug: city.slug, isActive: city.isActive }),
  });
  res.json({ success: true, data: cityResponse(city) });
});

adminRouter.post("/categories", async (req, res) => {
  const id = String(req.body?.id ?? req.body?.slug ?? "").trim().slice(0, 120);
  const slug = String(req.body?.slug ?? id).trim().slice(0, 120);
  const nameAr = String(req.body?.nameAr ?? req.body?.name?.ar ?? "").trim().slice(0, 120);
  const nameEn = String(req.body?.nameEn ?? req.body?.name?.en ?? "").trim().slice(0, 120);
  if (!id || !slug || !nameAr || !nameEn) {
    throw new AppError(400, "id, slug, nameAr and nameEn are required.", "VALIDATION_ERROR");
  }
  const now = new Date();
  const category = await prisma.category.create({
    data: {
      id,
      slug,
      nameAr,
      nameEn,
      isActive: req.body?.isActive !== false,
      sortOrder: Number.isInteger(req.body?.sortOrder) ? req.body.sortOrder : 0,
      createdAt: now,
      updatedAt: now,
    },
  });
  await logAuditEvent({
    actorId: actorId(req),
    action: "admin.category.create",
    targetType: "category",
    targetId: category.id,
    metadata: cleanMetadata({ slug: category.slug }),
  });
  res.status(201).json({ success: true, data: category });
});

adminRouter.patch("/categories/:id", async (req, res) => {
  const data: Prisma.CategoryUpdateInput = { updatedAt: new Date() };
  if (typeof req.body?.nameAr === "string" || typeof req.body?.name?.ar === "string") {
    data.nameAr = String(req.body?.nameAr ?? req.body.name.ar).trim().slice(0, 120);
  }
  if (typeof req.body?.nameEn === "string" || typeof req.body?.name?.en === "string") {
    data.nameEn = String(req.body?.nameEn ?? req.body.name.en).trim().slice(0, 120);
  }
  if (typeof req.body?.slug === "string") data.slug = req.body.slug.trim().slice(0, 120);
  if (typeof req.body?.isActive === "boolean") data.isActive = req.body.isActive;
  if (Number.isInteger(req.body?.sortOrder)) data.sortOrder = req.body.sortOrder;
  const category = await prisma.category.update({ where: { id: req.params.id }, data });
  await logAuditEvent({
    actorId: actorId(req),
    action: "admin.category.update",
    targetType: "category",
    targetId: category.id,
    metadata: cleanMetadata({ slug: category.slug, isActive: category.isActive }),
  });
  res.json({ success: true, data: category });
});

adminRouter.get("/audit-logs", async (req, res) => {
  const page = pageParams(req, 200);
  const actor = stringQuery(req, "actor", 120);
  const action = stringQuery(req, "action", 120);
  const targetType = stringQuery(req, "targetType", 80);
  const where: Prisma.AuditLogWhereInput = {
    ...(actor ? { actorId: { contains: actor, mode: "insensitive" } } : {}),
    ...(action ? { action: { contains: action, mode: "insensitive" } } : {}),
    ...(targetType ? { targetType } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: page.limit, skip: page.offset }),
    prisma.auditLog.count({ where }),
  ]);
  res.json({
    success: true,
    data: items.map((log) => ({
      ...log,
      metadata: cleanMetadata(log.metadata as Record<string, unknown>),
      createdAt: log.createdAt.toISOString(),
    })),
    pagination: paginationMeta(total, page),
  });
});
