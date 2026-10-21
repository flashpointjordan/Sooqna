import { cleanupNotifications, type CleanupStore } from "./notifications.cleanup";

describe("notification retention cleanup", () => {
  it("deletes expired/soft-deleted notifications in bounded batches and old outbox rows", async () => {
    const calls: string[] = [];
    let page = 0;
    const store: CleanupStore = {
      findNotificationIds: async () => page++ === 0 ? Array.from({ length: 500 }, (_, index) => `n-${index}`) : [],
      deleteNotifications: async (ids) => { calls.push(`notifications:${ids.length}`); return ids.length; },
      deleteProcessedOutbox: async () => 4,
      deleteDeadOutbox: async () => 2,
    };
    const result = await cleanupNotifications(store, new Date("2026-08-24T00:00:00.000Z"));
    expect(result).toEqual({ notifications: 500, processedOutbox: 4, deadOutbox: 2 });
    expect(calls).toEqual(["notifications:500"]);
  });
});
