import request from "supertest";
import { Role } from "@prisma/client";

const mockVerifyIdToken = jest.fn();
const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    count: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  listing: {
    count: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  listingModerationLog: {
    create: jest.fn(),
    createMany: jest.fn(),
    findMany: jest.fn(),
  },
  notificationOutbox: {
    upsert: jest.fn(),
  },
  notificationBroadcast: {
    create: jest.fn(),
  },
  savedSearch: {
    findMany: jest.fn(),
  },
  message: {
    groupBy: jest.fn(),
  },
  favorite: {
    groupBy: jest.fn(),
  },
  report: {
    count: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  auditLog: {
    count: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  category: {
    count: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  city: {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  upload: {
    count: jest.fn(),
  },
  $queryRawUnsafe: jest.fn(),
  $transaction: jest.fn(),
};

jest.mock("../../config/firebaseAdmin", () => ({
  adminAuth: {
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
  },
}));

jest.mock("../../config/prisma", () => ({
  prisma: mockPrisma,
}));

jest.mock("../notifications/notifications.operations", () => {
  const actual = jest.requireActual("../notifications/notifications.operations");
  return {
    ...actual,
    createNotificationOperationsRepository: () => new actual.PrismaNotificationOperationsRepository(),
  };
});

import { app } from "../../app";
import { adminRouter } from "./admin.routes";

function mockUser(role: Role) {
  const user = {
    id: `${role.toLowerCase()}-db`,
    firebaseUid: `${role.toLowerCase()}-uid`,
    email: `${role.toLowerCase()}@example.com`,
    name: `${role} User`,
    avatarUrl: "",
    bio: "",
    phone: "",
    role,
    accountStatus: "active",
    isEmailVerified: true,
    isPhoneVerified: false,
    isIdVerified: false,
    avgRating: 0,
    totalReviews: 0,
    totalListings: 0,
    totalSold: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  mockPrisma.user.findUnique.mockResolvedValue(user);
  mockPrisma.user.upsert.mockResolvedValue(user);
}

describe("admin routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyIdToken.mockImplementation(async (token: string) => ({
      uid: token === "buyer-token" ? "buyer-uid" : "admin-uid",
      email: "admin@example.com",
      email_verified: true,
      name: "Admin",
      picture: "",
    }));
    mockPrisma.auditLog.count.mockResolvedValue(1);
    mockPrisma.$transaction.mockImplementation(async (input: unknown) =>
      typeof input === "function"
        ? (input as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma)
        : Promise.all(input as Promise<unknown>[])
    );
    mockPrisma.notificationOutbox.upsert.mockResolvedValue({});
    mockPrisma.savedSearch.findMany.mockResolvedValue([]);
  });

  it("blocks unauthenticated users from admin stats", async () => {
    const response = await request(app).get("/api/admin/stats");

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHORIZED");
  });

  it("blocks normal users from admin stats", async () => {
    mockUser(Role.BUYER);

    const response = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", "Bearer buyer-token");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
  });

  it("allows admins to read paginated stats", async () => {
    mockUser(Role.ADMIN);
    mockPrisma.user.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(2);
    mockPrisma.listing.count
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(4);
    mockPrisma.report.count.mockResolvedValueOnce(5);
    mockPrisma.listing.groupBy.mockResolvedValueOnce([
      { locationCity: "amman", _count: { _all: 7 } },
    ]);
    mockPrisma.auditLog.findMany.mockResolvedValueOnce([]);

    const response = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", "Bearer admin-token");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.users.total).toBe(10);
    expect(response.body.data.listings.published).toBe(12);
    expect(response.body.data.reports.open).toBe(5);
    expect(response.body.data.topCities[0]).toEqual({ city: "amman", listingCount: 7 });
  });

  it("allows admins to read moderation SLA analytics", async () => {
    mockUser(Role.ADMIN);
    const now = new Date();
    mockPrisma.listing.findMany
      .mockResolvedValueOnce([
        { id: "pending-1", createdAt: new Date(now.getTime() - 2 * 36e5) },
        { id: "pending-2", createdAt: new Date(now.getTime() - 10 * 36e5) },
        { id: "pending-3", createdAt: new Date(now.getTime() - 30 * 36e5) },
      ])
      .mockResolvedValueOnce([
        { id: "decided-1", createdAt: new Date(now.getTime() - 12 * 36e5) },
        { id: "decided-2", createdAt: new Date(now.getTime() - 8 * 36e5) },
      ]);
    mockPrisma.listingModerationLog.findMany.mockResolvedValueOnce([
      { listingId: "decided-1", createdAt: new Date(now.getTime() - 6 * 36e5) },
      { listingId: "decided-2", createdAt: new Date(now.getTime() - 2 * 36e5) },
    ]);

    const response = await request(app)
      .get("/api/admin/analytics/moderation-sla")
      .set("Authorization", "Bearer admin-token");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.pendingCount).toBe(3);
    expect(response.body.data.oldestPendingAgeHours).toBeGreaterThanOrEqual(29);
    expect(response.body.data.averageDecisionHours).toBe(6);
    expect(response.body.data.pendingAgeBuckets).toEqual([
      { label: "0-6h", count: 1 },
      { label: "6-24h", count: 1 },
      { label: "24h+", count: 1 },
    ]);
  });

  it("allows admins to read top listing performance analytics", async () => {
    mockUser(Role.ADMIN);
    mockPrisma.listing.findMany.mockResolvedValueOnce([
      {
        id: "lst-views",
        title: "Popular listing",
        status: "published",
        categoryId: "cars",
        locationCity: "amman",
        viewsCount: 120,
        favoritesCount: 8,
        messagesCount: 3,
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    ]);

    const response = await request(app)
      .get("/api/admin/analytics/top-listings?metric=views&limit=50")
      .set("Authorization", "Bearer admin-token");

    expect(response.status).toBe(200);
    expect(response.body.data[0]).toEqual(
      expect.objectContaining({
        id: "lst-views",
        title: "Popular listing",
        viewsCount: 120,
        createdAt: "2026-05-01T00:00:00.000Z",
      })
    );
    expect(mockPrisma.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null },
        take: 25,
      })
    );
  });

  it("allows admins to read user activity analytics", async () => {
    mockUser(Role.ADMIN);
    mockPrisma.user.count
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(2);
    mockPrisma.listing.groupBy.mockResolvedValueOnce([{ ownerId: "seller-1" }, { ownerId: "seller-2" }]);
    mockPrisma.message.groupBy.mockResolvedValueOnce([{ senderId: "buyer-1" }]);
    mockPrisma.favorite.groupBy.mockResolvedValueOnce([{ userId: "buyer-1" }, { userId: "buyer-2" }]);

    const response = await request(app)
      .get("/api/admin/analytics/user-activity")
      .set("Authorization", "Bearer admin-token");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        activeUsers7d: 4,
        activeUsers30d: 9,
        usersWithListings7d: 2,
        usersWithMessages7d: 1,
        usersWithFavorites7d: 2,
      })
    );
    expect(response.body.data.newVsActive).toEqual([
      { label: "New users", count: 2 },
      { label: "Active users", count: 4 },
    ]);
  });

  it("audits admin listing rejection through explicit moderation endpoint", async () => {
    mockUser(Role.ADMIN);
    mockPrisma.listing.findUnique.mockResolvedValue({
      id: "lst-1", status: "pending", ownerId: "seller-1", title: "Flagged item",
      description: "Description", categoryId: "other", locationCity: "Amman", condition: "used", price: 10,
    });
    mockPrisma.listingModerationLog.create.mockResolvedValue({});
    mockPrisma.listing.update.mockResolvedValue({
      id: "lst-1",
      title: "Flagged item",
      ownerId: "seller-1",
      status: "rejected",
      isFeatured: false,
      isApproved: false,
      publishedAt: null,
      archivedAt: null,
      soldAt: null,
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const response = await request(app)
      .post("/api/admin/listings/lst-1/reject")
      .set("Authorization", "Bearer admin-token")
      .send({ reason: "Policy violation" });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mockPrisma.listing.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lst-1" },
        data: expect.objectContaining({
          status: "rejected",
          isFeatured: false,
        }),
      })
    );
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: "admin-uid",
          action: "admin.listing.reject",
          targetType: "listing",
          targetId: "lst-1",
        }),
      })
    );
    expect(mockPrisma.notificationOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "listing-rejected:lst-1:2026-01-02T00:00:00.000Z" },
      create: expect.objectContaining({
        eventType: "LISTING_REJECTED",
        recipientId: "seller-1",
        payload: expect.objectContaining({ rejectionReason: "Policy violation", listingTitle: "Flagged item" }),
      }),
      update: {},
    }));
  });

  it("allows admins to publish a pending listing through moderation", async () => {
    mockUser(Role.ADMIN);
    const publishedAt = new Date("2026-01-02T00:00:00.000Z");
    mockPrisma.listing.findUnique.mockResolvedValue({
      id: "lst-1", status: "pending", ownerId: "seller-1", title: "Ready item",
      description: "Description", categoryId: "other", locationCity: "Amman", condition: "used", price: 10,
    });
    mockPrisma.listingModerationLog.create.mockResolvedValue({});
    mockPrisma.listing.update.mockResolvedValue({
      id: "lst-1",
      title: "Ready item",
      description: "Description",
      ownerId: "seller-1",
      categoryId: "other",
      locationCity: "Amman",
      condition: "used",
      price: 10,
      status: "published",
      isFeatured: false,
      isApproved: true,
      publishedAt,
      archivedAt: null,
      soldAt: null,
      updatedAt: publishedAt,
    });

    const response = await request(app)
      .post("/api/admin/listings/lst-1/publish")
      .set("Authorization", "Bearer admin-token");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe("published");
    expect(response.body.data.isApproved).toBe(true);
    expect(mockPrisma.listing.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lst-1" },
        data: expect.objectContaining({
          status: "published",
          isApproved: true,
          archivedAt: null,
        }),
      })
    );
    expect(mockPrisma.listingModerationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          listingId: "lst-1",
          adminUserId: "admin-uid",
          action: "publish",
          previousStatus: "pending",
          newStatus: "published",
        }),
      })
    );
    expect(mockPrisma.notificationOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "listing-approved:lst-1:2026-01-02T00:00:00.000Z" },
      create: expect.objectContaining({ eventType: "LISTING_APPROVED", recipientId: "seller-1" }),
      update: {},
    }));
    expect(mockPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it("rolls back a moderation transition and log when notification enqueue fails", async () => {
    mockUser(Role.ADMIN);
    const db = {
      listing: { status: "pending" },
      logs: [] as string[],
    };
    mockPrisma.listing.findUnique.mockImplementation(async () => ({
      id: "lst-rollback", status: db.listing.status, ownerId: "seller-1", title: "Rollback item",
      description: "Description", categoryId: "other", locationCity: "damascus", condition: "used", price: 10,
    }));
    mockPrisma.listing.update.mockImplementation(async () => {
      db.listing.status = "rejected";
      return { id: "lst-rollback", title: "Rollback item", ownerId: "seller-1", status: "rejected", isFeatured: false, isApproved: false, publishedAt: null, archivedAt: null, soldAt: null, updatedAt: new Date("2026-01-02T00:00:00.000Z") };
    });
    mockPrisma.listingModerationLog.create.mockImplementation(async () => { db.logs.push("reject"); return {}; });
    mockPrisma.notificationOutbox.upsert.mockRejectedValueOnce(new Error("outbox unavailable"));
    mockPrisma.$transaction.mockImplementationOnce(async (work: (tx: typeof mockPrisma) => Promise<unknown>) => {
      const snapshot = { status: db.listing.status, logs: [...db.logs] };
      try { return await work(mockPrisma); }
      catch (error) { db.listing.status = snapshot.status; db.logs = snapshot.logs; throw error; }
    });

    const response = await request(app)
      .post("/api/admin/listings/lst-rollback/reject")
      .set("Authorization", "Bearer admin-token")
      .send({ reason: "Policy violation" });

    expect(response.status).toBe(500);
    expect(db).toEqual({ listing: { status: "pending" }, logs: [] });
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("bulk moderation logs and emits only rows that confirm a state transition", async () => {
    mockUser(Role.ADMIN);
    mockPrisma.listing.findMany.mockResolvedValueOnce([
      { id: "lst-transitioned", status: "pending", ownerId: "seller-1", title: "One", description: "", categoryId: "other", locationCity: "damascus", condition: "used", price: 10 },
      { id: "lst-raced", status: "pending", ownerId: "seller-2", title: "Two", description: "", categoryId: "other", locationCity: "damascus", condition: "used", price: 20 },
    ]);
    mockPrisma.listing.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    mockPrisma.listingModerationLog.createMany.mockResolvedValue({ count: 1 });

    const response = await request(app)
      .post("/api/admin/moderation/listings/bulk")
      .set("Authorization", "Bearer admin-token")
      .send({ ids: ["lst-transitioned", "lst-raced"], action: "publish" });

    expect(response.status).toBe(200);
    expect(response.body.data.updatedCount).toBe(1);
    expect(mockPrisma.listingModerationLog.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ listingId: "lst-transitioned", previousStatus: "pending", newStatus: "published" })],
    });
    expect(mockPrisma.notificationOutbox.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.notificationOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ aggregateId: "lst-transitioned" }),
    }));
  });

  it("allows admins to manage cities", async () => {
    mockUser(Role.ADMIN);
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    mockPrisma.city.findMany.mockResolvedValueOnce([
      {
        id: "amman",
        nameAr: "عمّان",
        nameEn: "Amman",
        slug: "amman",
        isActive: true,
        sortOrder: 1,
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    mockPrisma.listing.groupBy.mockResolvedValueOnce([{ locationCity: "amman", _count: { _all: 2 } }]);
    mockPrisma.city.create.mockResolvedValueOnce({
      id: "irbid",
      nameAr: "إربد",
      nameEn: "Irbid",
      slug: "irbid",
      isActive: true,
      sortOrder: 2,
      createdAt,
      updatedAt: createdAt,
    });
    mockPrisma.city.update.mockResolvedValueOnce({
      id: "irbid",
      nameAr: "إربد",
      nameEn: "Irbid",
      slug: "irbid",
      isActive: false,
      sortOrder: 2,
      createdAt,
      updatedAt: createdAt,
    });

    const listResponse = await request(app)
      .get("/api/admin/cities")
      .set("Authorization", "Bearer admin-token");
    const createResponse = await request(app)
      .post("/api/admin/cities")
      .set("Authorization", "Bearer admin-token")
      .send({ id: "irbid", slug: "irbid", nameAr: "إربد", nameEn: "Irbid", sortOrder: 2 });
    const updateResponse = await request(app)
      .patch("/api/admin/cities/irbid")
      .set("Authorization", "Bearer admin-token")
      .send({ isActive: false });

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data[0].listingCount).toBe(2);
    expect(createResponse.status).toBe(201);
    expect(createResponse.body.data.slug).toBe("irbid");
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.data.isActive).toBe(false);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "admin.city.create",
          targetType: "city",
          targetId: "irbid",
        }),
      })
    );
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "admin.city.update",
          targetType: "city",
          targetId: "irbid",
        }),
      })
    );
  });

  it("accepts a validated admin notification broadcast and audits no body content", async () => {
    mockUser(Role.ADMIN);
    const createdAt = new Date("2026-09-12T10:00:00.000Z");
    mockPrisma.notificationBroadcast.create.mockResolvedValueOnce({
      id: "broadcast-1",
      audience: "ALL",
      audienceValue: {},
      title: "Maintenance",
      body: "Private broadcast copy",
      actionUrl: "/notifications",
      status: "PENDING",
      cursor: null,
      deliveredCount: 0,
      createdBy: "admin-uid",
      createdAt,
      updatedAt: createdAt,
    });

    const response = await request(app)
      .post("/api/admin/notifications/broadcasts")
      .set("Authorization", "Bearer admin-token")
      .send({ audience: "ALL", audienceValue: null, title: "Maintenance", body: "Private broadcast copy", actionUrl: "/notifications" });

    expect(response.status).toBe(202);
    expect(response.body.data).toEqual({ id: "broadcast-1", status: "PENDING", deliveredCount: 0 });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "admin.notification.broadcast", targetId: "broadcast-1", metadata: { audience: "ALL" } }),
    }));
    expect(JSON.stringify(mockPrisma.auditLog.create.mock.calls)).not.toContain("Private broadcast copy");
  });

  it("rate limits the admin broadcast endpoint", () => {
    const layer = adminRouter.stack.find((item) => item.route?.path === "/notifications/broadcasts");
    expect(layer?.route?.stack).toHaveLength(3);
  });
});
