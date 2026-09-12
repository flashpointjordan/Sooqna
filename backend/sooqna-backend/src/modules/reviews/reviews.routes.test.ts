import request from "supertest";

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
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  },
  listingModerationLog: {
    create: jest.fn(),
    createMany: jest.fn(),
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
  review: {
    aggregate: jest.fn(),
    create: jest.fn(),
    findFirst: jest.fn(),
  },
  auditLog: {
    count: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  notificationOutbox: {
    upsert: jest.fn(),
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

import { app } from "../../app";
import { env } from "../../config/env";

const originalRequireEmailVerified = env.requireEmailVerified;

function dbUser(overrides?: Record<string, unknown>) {
  return {
    id: "buyer-1",
    firebaseUid: "buyer-1",
    email: "buyer@example.com",
    name: "Buyer One",
    avatarUrl: "",
    bio: "",
    phone: "",
    role: "BUYER",
    accountStatus: "active",
    isEmailVerified: true,
    isPhoneVerified: false,
    isIdVerified: false,
    avgRating: 0,
    totalReviews: 0,
    totalListings: 0,
    totalSold: 0,
    lastLoginAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function reviewPayload(overrides?: Record<string, unknown>) {
  return {
    sellerId: "seller-1",
    listingId: "listing-1",
    rating: 5,
    comment: "Great seller",
    ...overrides,
  };
}

describe("review route guards", () => {
  afterAll(() => {
    env.requireEmailVerified = originalRequireEmailVerified;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    env.requireEmailVerified = true;
    mockVerifyIdToken.mockImplementation(async (token: string) => {
      if (token === "invalid-token") throw new Error("invalid token");
      return {
        uid: token === "seller-token" ? "seller-1" : "buyer-1",
        email: "buyer@example.com",
        email_verified: token !== "unverified-token",
        name: "Buyer One",
        picture: "",
      };
    });
    const activeUser = dbUser();
    mockPrisma.user.findUnique.mockImplementation(async (args: { where?: { firebaseUid?: string } }) => {
      const firebaseUid = args.where?.firebaseUid ?? "buyer-1";
      if (firebaseUid === "seller-1") {
        return dbUser({
          id: "seller-1",
          firebaseUid: "seller-1",
          email: "seller@example.com",
          name: "Seller One",
        });
      }
      return activeUser;
    });
    mockPrisma.user.upsert.mockImplementation(
      async (args: {
        where?: { firebaseUid?: string };
        update?: {
          email?: string;
          name?: string;
          avatarUrl?: string;
          role?: string;
          accountStatus?: string;
          isEmailVerified?: boolean;
        };
      }) =>
        dbUser({
          id: args.where?.firebaseUid ?? "buyer-1",
          firebaseUid: args.where?.firebaseUid ?? "buyer-1",
          email: args.update?.email ?? activeUser.email,
          name: args.update?.name ?? activeUser.name,
          avatarUrl: args.update?.avatarUrl ?? activeUser.avatarUrl,
          role: args.update?.role ?? activeUser.role,
          accountStatus: args.update?.accountStatus ?? activeUser.accountStatus,
          isEmailVerified: args.update?.isEmailVerified ?? activeUser.isEmailVerified,
        })
    );
    mockPrisma.listing.findFirst.mockResolvedValue({
      id: "listing-1",
      ownerId: "seller-1",
      title: "Trusted listing",
      deletedAt: null,
    });
    mockPrisma.review.findFirst.mockResolvedValue(null);
    mockPrisma.review.create.mockResolvedValue({
      id: "rev-1",
      sellerId: "seller-1",
      reviewerId: "buyer-1",
      listingId: "listing-1",
      rating: 5,
      comment: "Great seller",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    mockPrisma.review.aggregate.mockResolvedValue({
      _avg: { rating: 5 },
      _count: { id: 1 },
    });
    mockPrisma.listing.count.mockResolvedValue(1);
    mockPrisma.user.update.mockResolvedValue(activeUser);
    mockPrisma.auditLog.count.mockResolvedValue(1);
    mockPrisma.auditLog.create.mockResolvedValue({});
    mockPrisma.notificationOutbox.upsert.mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(async (queries: unknown[]) => Promise.all(queries));
  });

  it("rejects review creation without a token", async () => {
    const response = await request(app).post("/api/reviews").send(reviewPayload());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHORIZED");
  });

  it("rejects review creation with an invalid token", async () => {
    const response = await request(app)
      .post("/api/reviews")
      .set("Authorization", "Bearer invalid-token")
      .send(reviewPayload());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHORIZED");
  });

  it("rejects review creation for unverified users", async () => {
    const unverifiedUser = dbUser({ isEmailVerified: false });
    mockPrisma.user.findUnique.mockResolvedValue(unverifiedUser);
    mockPrisma.user.upsert.mockResolvedValue(unverifiedUser);

    const response = await request(app)
      .post("/api/reviews")
      .set("Authorization", "Bearer unverified-token")
      .send(reviewPayload());

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("EMAIL_NOT_VERIFIED");
    expect(mockPrisma.review.create).not.toHaveBeenCalled();
  });

  it("rejects review creation for suspended users", async () => {
    const suspendedUser = dbUser({ accountStatus: "suspended" });
    mockPrisma.user.findUnique.mockResolvedValue(suspendedUser);
    mockPrisma.user.upsert.mockResolvedValue(suspendedUser);

    const response = await request(app)
      .post("/api/reviews")
      .set("Authorization", "Bearer buyer-token")
      .send(reviewPayload());

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ACCOUNT_NOT_ACTIVE");
    expect(mockPrisma.review.create).not.toHaveBeenCalled();
  });

  it("creates a review for verified active users using the token identity", async () => {
    const response = await request(app)
      .post("/api/reviews")
      .set("Authorization", "Bearer buyer-token")
      .send(reviewPayload());

    expect(response.status).toBe(201);
    expect(response.body.review.reviewerId).toBe("buyer-1");
    expect(mockPrisma.review.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reviewerId: "buyer-1",
        }),
      })
    );
    expect(mockPrisma.notificationOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "review:rev-1:seller-1" },
      create: expect.objectContaining({
        eventType: "REVIEW_RECEIVED",
        recipientId: "seller-1",
        payload: {
          eventType: "REVIEW_RECEIVED",
          recipientId: "seller-1",
          reviewId: "rev-1",
          reviewerId: "buyer-1",
          reviewerName: "Buyer One",
          listingId: "listing-1",
          listingTitle: "Trusted listing",
          rating: 5,
        },
      }),
    }));
    expect(JSON.stringify(mockPrisma.notificationOutbox.upsert.mock.calls)).not.toContain("Great seller");
  });

  it("rejects duplicate reviews", async () => {
    mockPrisma.review.findFirst.mockResolvedValue({
      id: "rev-existing",
      sellerId: "seller-1",
      reviewerId: "buyer-1",
      listingId: "listing-1",
      rating: 4,
      comment: "Already reviewed",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const response = await request(app)
      .post("/api/reviews")
      .set("Authorization", "Bearer buyer-token")
      .send(reviewPayload());

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("DUPLICATE_REVIEW");
  });

  it("rejects self reviews", async () => {
    const response = await request(app)
      .post("/api/reviews")
      .set("Authorization", "Bearer seller-token")
      .send(reviewPayload({ sellerId: "seller-1" }));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });
});
