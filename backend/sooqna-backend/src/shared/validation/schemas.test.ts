import { createConversationBodySchema, createMessageBodySchema } from "./schemas";

describe("createConversationBodySchema", () => {
  it("accepts the minimal trusted conversation creation payload", () => {
    const parsed = createConversationBodySchema.safeParse({
      listingId: "listing-1",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts legacy ignored participant snapshots with blank photo URLs", () => {
    const parsed = createConversationBodySchema.safeParse({
      listingId: "listing-1",
      participantIds: ["buyer-1", "seller-1"],
      participants: {
        "buyer-1": {
          fullName: "Buyer One",
          photoURL: "",
        },
        "seller-1": {
          fullName: "Seller One",
          photoURL: "",
        },
      },
      listingSnapshot: {
        title: "Camera",
        primaryImageURL: "",
      },
      createdBy: "buyer-1",
    });

    expect(parsed.success).toBe(true);
  });
});

describe("createMessageBodySchema", () => {
  it("rejects a missing clientRequestId", () => {
    const parsed = createMessageBodySchema.safeParse({ type: "text", text: "Hello" });

    expect(parsed.success).toBe(false);
  });

  it("rejects a clientRequestId shorter than eight trimmed characters", () => {
    const parsed = createMessageBodySchema.safeParse({
      type: "text",
      text: "Hello",
      clientRequestId: "  short  ",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts at most 128 clientRequestId characters", () => {
    const accepted = createMessageBodySchema.safeParse({
      type: "text",
      text: "Hello",
      clientRequestId: "r".repeat(128),
    });
    const rejected = createMessageBodySchema.safeParse({
      type: "text",
      text: "Hello",
      clientRequestId: "r".repeat(129),
    });

    expect(accepted.success).toBe(true);
    expect(rejected.success).toBe(false);
  });

  it("accepts and trims a valid clientRequestId without accepting senderId", () => {
    const parsed = createMessageBodySchema.safeParse({
      type: "text",
      text: "Hello",
      clientRequestId: "  request-123  ",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({
      type: "text",
      text: "Hello",
      attachments: [],
      clientRequestId: "request-123",
    });
    expect(parsed.data).not.toHaveProperty("senderId");
  });

  it("rejects a client-supplied senderId", () => {
    const parsed = createMessageBodySchema.safeParse({
      type: "text",
      text: "Hello",
      clientRequestId: "request-123",
      senderId: "attacker-uid",
    });

    expect(parsed.success).toBe(false);
  });
});
