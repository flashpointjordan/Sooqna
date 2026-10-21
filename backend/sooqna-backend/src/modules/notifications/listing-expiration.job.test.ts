import { runListingExpirationJob } from "./listing-expiration.job";

describe("listing expiration job", () => {
  it("emits deterministic seven-day warnings and archives expired listings", async () => {
    const tx = { listing: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, notificationOutbox: { upsert: jest.fn().mockResolvedValue({}) } } as any;
    const prisma = {
      listing: {
        findMany: jest.fn().mockResolvedValueOnce([{ id: "expiring", ownerId: "owner", title: "Car", expiresAt: new Date("2026-08-30T00:00:00Z"), status: "published" }]).mockResolvedValueOnce([{ id: "expired", ownerId: "owner", title: "Bike", expiresAt: new Date("2026-08-20T00:00:00Z"), status: "published" }]),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    } as any;
    await runListingExpirationJob({ prisma, now: () => new Date("2026-08-24T00:00:00Z") });
    expect(tx.notificationOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { dedupeKey: "listing:expiring:expiring:2026-08-24" } }));
    expect(tx.listing.updateMany).toHaveBeenCalled();
  });
});
