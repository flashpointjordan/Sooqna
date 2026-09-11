import type { Request, Response } from "express";

const mockFindListingById = jest.fn();
const mockCreateConversationInService = jest.fn();
const mockCreateMessageInService = jest.fn();
const mockLogAuditEvent = jest.fn();

jest.mock("../listings/repositories/listings.repository", () => ({
  PrismaListingsRepository: jest.fn().mockImplementation(() => ({
    findById: mockFindListingById,
  })),
}));

jest.mock("./messages.service", () => ({
  MessagesService: jest.fn().mockImplementation(() => ({
    createConversation: mockCreateConversationInService,
    createMessage: mockCreateMessageInService,
  })),
}));

jest.mock("../audit/audit.service", () => ({ logAuditEvent: mockLogAuditEvent }));

jest.mock("./repositories/messages.repository", () => ({
  PrismaMessagesRepository: jest.fn(),
}));

function createResponse(): jest.Mocked<Pick<Response, "status" | "json">> {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

describe("message conversation identity", () => {
  beforeEach(() => {
    mockFindListingById.mockReset();
    mockCreateConversationInService.mockReset();
    mockCreateMessageInService.mockReset();
    mockLogAuditEvent.mockReset();
  });

  it.each([
    [true, 201, 1],
    [false, 200, 0],
  ])("returns the correct status and audits only when created=%s", async (created, status, auditCalls) => {
    const message = { id: "msg-1", type: "text", senderId: "trusted-user", clientRequestId: "request-123" };
    mockCreateMessageInService.mockResolvedValue({ message, created });
    const req = {
      currentUser: { firebaseUid: "trusted-user" },
      params: { conversationId: "conv-1" },
      body: { senderId: "attacker", clientRequestId: "request-123", type: "text", text: "Hello" },
    } as unknown as Request;
    const res = createResponse();

    const { createMessage } = await import("./messages.controller");
    await createMessage(req, res as unknown as Response);

    expect(mockCreateMessageInService).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      senderId: "trusted-user",
      clientRequestId: "request-123",
    }));
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith({ success: true, message, created });
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(auditCalls);
  });

  it("derives participants from authenticated user and listing owner instead of trusting client participantIds", async () => {
    mockFindListingById.mockResolvedValue({
      id: "listing-1",
      ownerId: "seller-1",
      status: "published",
      title: "Camera",
      images: [{ url: "https://cdn.example.com/camera.jpg", path: "uploads/listings/camera.jpg", isPrimary: true, order: 0 }],
      ownerSnapshot: { fullName: "Seller One", photoURL: "https://cdn.example.com/seller.jpg" },
    });
    mockCreateConversationInService.mockResolvedValue({
      id: "conv-1",
      participantIds: ["buyer-1", "seller-1"],
    });

    const req = {
      authUser: {
        uid: "buyer-1",
        name: "Buyer One",
        picture: "https://cdn.example.com/buyer.jpg",
      },
      currentUser: {
        firebaseUid: "buyer-1",
        email: "buyer@example.com",
        emailVerified: true,
        displayName: "Buyer One",
        photoURL: "https://cdn.example.com/buyer.jpg",
        dbUser: { id: "buyer-1", firebaseUid: "buyer-1" },
        role: "BUYER",
        accountStatus: "active",
      },
      body: {
        listingId: "listing-1",
        participantIds: ["attacker-uid"],
        participants: {
          "attacker-uid": { fullName: "Attacker" },
        },
        listingSnapshot: {
          title: "Fake title",
          primaryImageURL: "https://cdn.example.com/fake.jpg",
        },
      },
    } as unknown as Request;
    const res = createResponse();

    const { createConversation } = await import("./messages.controller");
    await createConversation(req, res as unknown as Response);

    expect(mockCreateConversationInService).toHaveBeenCalledWith(
      expect.objectContaining({
        participantIds: ["buyer-1", "seller-1"],
        participants: {
          "buyer-1": {
            fullName: "Buyer One",
            photoURL: "https://cdn.example.com/buyer.jpg",
          },
          "seller-1": {
            fullName: "Seller One",
            photoURL: "https://cdn.example.com/seller.jpg",
          },
        },
        listingSnapshot: {
          title: "Camera",
          primaryImageURL: "https://cdn.example.com/camera.jpg",
        },
        createdBy: "buyer-1",
      })
    );
  });

  it("blocks users from messaging their own listing", async () => {
    mockFindListingById.mockResolvedValue({
      id: "listing-1",
      ownerId: "buyer-1",
      status: "published",
      title: "Camera",
      images: [],
      ownerSnapshot: { fullName: "Buyer One", photoURL: "" },
    });

    const req = {
      currentUser: {
        firebaseUid: "buyer-1",
        displayName: "Buyer One",
        photoURL: "",
      },
      body: { listingId: "listing-1" },
    } as unknown as Request;
    const res = createResponse();

    const { createConversation } = await import("./messages.controller");
    await expect(createConversation(req, res as unknown as Response)).rejects.toThrow(
      "You cannot message your own listing."
    );
  });

  it("blocks conversations for listings that are not published", async () => {
    mockFindListingById.mockResolvedValue({
      id: "listing-1",
      ownerId: "seller-1",
      status: "draft",
      title: "Camera",
      images: [],
      ownerSnapshot: { fullName: "Seller One", photoURL: "" },
    });

    const req = {
      currentUser: {
        firebaseUid: "buyer-1",
        displayName: "Buyer One",
        photoURL: "",
      },
      body: { listingId: "listing-1" },
    } as unknown as Request;
    const res = createResponse();

    const { createConversation } = await import("./messages.controller");
    await expect(createConversation(req, res as unknown as Response)).rejects.toThrow(
      "Listing is not available for messaging."
    );
  });
});
