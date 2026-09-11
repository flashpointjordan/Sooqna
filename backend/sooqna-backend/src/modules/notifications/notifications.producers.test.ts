import { logger } from "../../config/logger";
import type { MessagesRepository } from "../messages/repositories/messages.repository";
import type { ReviewsRepository } from "../reviews/repositories/reviews.repository";
import type { FavoritesRepository } from "../favorites/repositories/favorites.repository";
import type { NotificationEventPayload } from "./notifications.types";

const mockListingFindById = jest.fn();
const mockPrisma = {
  engagementEvent: { create: jest.fn() },
  listing: { findFirst: jest.fn(), count: jest.fn() },
  review: { aggregate: jest.fn() },
  user: { update: jest.fn(), findUnique: jest.fn() },
};

jest.mock("../../config/prisma", () => ({ prisma: mockPrisma }));
jest.mock("../listings/repositories/listings.repository", () => ({
  PrismaListingsRepository: jest.fn().mockImplementation(() => ({ findById: mockListingFindById, update: jest.fn() })),
}));

type CapturedEvent = {
  payload: NotificationEventPayload;
  aggregateType: string;
  aggregateId: string;
  recipientId?: string;
  dedupeKey: string;
  aggregationKey?: string;
};
type Enqueue = (event: CapturedEvent) => Promise<unknown>;

function conversation() {
  return {
    id: "conv-1",
    participantIds: ["sender-1", "recipient-1", "recipient-2"],
    participants: {
      "sender-1": { fullName: "Sender One", photoURL: "" },
      "recipient-1": { fullName: "Recipient One", photoURL: "" },
      "recipient-2": { fullName: "Recipient Two", photoURL: "" },
    },
    listingId: "listing-1",
    listingSnapshot: { title: "Trusted listing", primaryImageURL: "" },
    createdBy: "sender-1",
    lastMessageText: "",
    lastMessageSenderId: "",
    lastMessageAt: null,
    lastMessageType: "text" as const,
    isActive: true,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

describe("marketplace engagement notification producers", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-24T15:42:00.000Z"));
    jest.clearAllMocks();
    mockPrisma.engagementEvent.create.mockResolvedValue({});
    mockPrisma.listing.count.mockResolvedValue(1);
    mockPrisma.review.aggregate.mockResolvedValue({ _avg: { rating: 5 }, _count: { id: 1 } });
    mockPrisma.user.update.mockResolvedValue({});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("fans a persisted message out to every non-sender participant with safe facts", async () => {
    const { MessagesService } = await import("../messages/messages.service");
    const repo: jest.Mocked<MessagesRepository> = {
      createConversation: jest.fn(),
      findConversationById: jest.fn().mockResolvedValue(conversation()),
      listConversationsForUser: jest.fn(),
      updateConversation: jest.fn().mockResolvedValue(conversation()),
      createMessage: jest.fn().mockImplementation(async (message) => message),
      listMessages: jest.fn(),
      markConversationMessagesRead: jest.fn(),
      getUnreadCountMapForUser: jest.fn(),
    };
    const enqueue: jest.MockedFunction<Enqueue> = jest.fn().mockResolvedValue({});
    const body = `hello ${"x".repeat(240)} password=super-secret token=top-secret alice@example.com`;
    const service = new (MessagesService as unknown as new (repo: MessagesRepository, enqueue: Enqueue) => InstanceType<typeof MessagesService>)(repo, enqueue);

    const message = await service.createMessage({ conversationId: "conv-1", senderId: "sender-1", clientRequestId: "request-123", type: "text", text: body });

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(1, expect.objectContaining({
      aggregateType: "message",
      aggregateId: message.id,
      recipientId: "recipient-1",
      dedupeKey: `message:${message.id}:recipient-1`,
      payload: expect.objectContaining({ eventType: "MESSAGE_RECEIVED", recipientId: "recipient-1", senderId: "sender-1", senderName: "Sender One", conversationId: "conv-1", listingId: "listing-1", listingTitle: "Trusted listing" }),
    }));
    expect(enqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({ recipientId: "recipient-2", dedupeKey: `message:${message.id}:recipient-2` }));
    const facts = enqueue.mock.calls.map(([event]) => event.payload);
    expect(JSON.stringify(facts)).not.toContain(body);
    expect(JSON.stringify(facts)).not.toContain("super-secret");
    expect(JSON.stringify(facts)).not.toContain("top-secret");
    expect(JSON.stringify(facts)).not.toContain("alice@example.com");
  });

  it("rejects the message transaction when notification enqueue fails", async () => {
    const { MessagesService } = await import("../messages/messages.service");
    const repo = {
      findConversationById: jest.fn().mockResolvedValue(conversation()),
      createMessage: jest.fn().mockImplementation(async (message) => message),
      updateConversation: jest.fn().mockResolvedValue(conversation()),
    } as unknown as MessagesRepository;
    const enqueue = jest.fn().mockRejectedValue(new Error("outbox unavailable"));
    const service = new (MessagesService as unknown as new (repo: MessagesRepository, enqueue: Enqueue) => InstanceType<typeof MessagesService>)(repo, enqueue);

    await expect(service.createMessage({ conversationId: "conv-1", senderId: "sender-1", clientRequestId: "request-456", type: "text", text: "Hello" })).rejects.toThrow("outbox unavailable");
  });

  it("notifies a listing owner once only when a favorite is newly created, never for remove or self-favorites", async () => {
    const { FavoritesService } = await import("../favorites/favorites.service");
    mockListingFindById.mockResolvedValue({ id: "listing-1", ownerId: "owner-1", title: "Trusted listing", favoritesCount: 0, updatedAt: "2026-08-24T00:00:00.000Z" });
    const upsert = jest.fn().mockResolvedValue({ created: true });
    const repo = {
      listByUser: jest.fn(),
      upsert,
      remove: jest.fn(),
      countByListing: jest.fn().mockResolvedValue(4),
    } as unknown as FavoritesRepository;
    const enqueue: jest.MockedFunction<Enqueue> = jest.fn().mockResolvedValue({});
    const service = new (FavoritesService as unknown as new (repo: FavoritesRepository, enqueue: Enqueue) => InstanceType<typeof FavoritesService>)(repo, enqueue);

    await service.add("actor-1", "listing-1");
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      aggregateType: "listing",
      aggregateId: "listing-1",
      recipientId: "owner-1",
      dedupeKey: "favorite:listing-1:actor-1",
      aggregationKey: "listing-favorite:listing-1:2026-08-24T15",
      payload: { eventType: "LISTING_FAVORITED_AGGREGATE", recipientId: "owner-1", listingId: "listing-1", listingTitle: "Trusted listing", favoriteCount: 4 },
    }));

    upsert.mockResolvedValue({ created: false });
    await service.add("actor-1", "listing-1");
    await service.remove("actor-1", "listing-1");
    mockListingFindById.mockResolvedValue({ id: "listing-1", ownerId: "actor-1", title: "Trusted listing", favoritesCount: 0, updatedAt: "2026-08-24T00:00:00.000Z" });
    upsert.mockResolvedValue({ created: true });
    await service.add("actor-1", "listing-1");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("notifies the seller after review persistence and stats recalculation without leaking review text", async () => {
    const { ReviewsService } = await import("../reviews/reviews.service");
    mockPrisma.listing.findFirst.mockResolvedValue({ id: "listing-1", ownerId: "seller-1", title: "Trusted listing" });
    mockPrisma.user.findUnique.mockResolvedValue({ name: "Reviewer One" });
    const repo: jest.Mocked<ReviewsRepository> = {
      create: jest.fn().mockImplementation(async (review) => review),
      findByReviewerAndListing: jest.fn().mockResolvedValue(null),
      listBySeller: jest.fn(),
      listByListing: jest.fn(),
    };
    const enqueue: jest.MockedFunction<Enqueue> = jest.fn().mockResolvedValue({});
    const service = new (ReviewsService as unknown as new (repo: ReviewsRepository, enqueue: Enqueue) => InstanceType<typeof ReviewsService>)(repo, enqueue);

    const review = await service.createReview({ sellerId: "seller-1", reviewerId: "reviewer-1", listingId: "listing-1", rating: 5, comment: "password=not-for-notifications" });

    expect(mockPrisma.user.update).toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      aggregateType: "review",
      aggregateId: review.id,
      recipientId: "seller-1",
      dedupeKey: `review:${review.id}:seller-1`,
      payload: { eventType: "REVIEW_RECEIVED", recipientId: "seller-1", reviewId: review.id, reviewerId: "reviewer-1", reviewerName: "Reviewer One", listingId: "listing-1", listingTitle: "Trusted listing", rating: 5 },
    }));
  });

  it("keeps a created review successful when notification enqueue fails", async () => {
    const { ReviewsService } = await import("../reviews/reviews.service");
    mockPrisma.listing.findFirst.mockResolvedValue({ id: "listing-1", ownerId: "seller-1", title: "Trusted listing" });
    mockPrisma.user.findUnique.mockResolvedValue({ name: "Reviewer One" });
    const repo = { create: jest.fn().mockImplementation(async (review) => review), findByReviewerAndListing: jest.fn().mockResolvedValue(null) } as unknown as ReviewsRepository;
    const enqueue = jest.fn().mockRejectedValue(new Error("outbox unavailable"));
    const log = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    const service = new (ReviewsService as unknown as new (repo: ReviewsRepository, enqueue: Enqueue) => InstanceType<typeof ReviewsService>)(repo, enqueue);

    await expect(service.createReview({ sellerId: "seller-1", reviewerId: "reviewer-1", listingId: "listing-1", rating: 4, comment: "Nice" })).resolves.toMatchObject({ sellerId: "seller-1" });
    expect(log).toHaveBeenCalledWith("Notification event enqueue failed", expect.objectContaining({ eventType: "REVIEW_RECEIVED", reviewId: expect.any(String), outcome: "failed" }));
  });
});
