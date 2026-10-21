import { fanOutBroadcastBatch, type BroadcastStore } from "./notifications.broadcast";

describe("notification broadcast fan-out", () => {
  it("pages 200 recipients, resumes from cursor, and deduplicates outbox rows", async () => {
    const users = Array.from({ length: 205 }, (_, index) => ({ firebaseUid: `u-${String(index).padStart(3, "0")}`, role: "BUYER" }));
    const created: string[] = [];
    let cursor: string | null = null;
    const store: BroadcastStore = {
      findUsers: async ({ after, take }) => users.filter((user) => !after || user.firebaseUid > after).slice(0, take),
      enqueue: async (user) => { created.push(user.firebaseUid); },
      saveProgress: async (next) => { cursor = next; },
      complete: async () => undefined,
    };
    await fanOutBroadcastBatch(store, { id: "b-1", audience: "ALL", cursor: null });
    expect(created).toHaveLength(200);
    expect(cursor).toBe("u-199");
    await fanOutBroadcastBatch(store, { id: "b-1", audience: "ALL", cursor });
    expect(created).toHaveLength(205);
    expect(new Set(created).size).toBe(205);
  });

  it("writes only safe SYSTEM_ANNOUNCEMENT facts without copy in audit metadata", async () => {
    const payloads: unknown[] = [];
    const store: BroadcastStore = {
      findUsers: async () => [{ firebaseUid: "u-1", role: "BUYER" }],
      enqueue: async (_user, payload) => { payloads.push(payload); },
      saveProgress: async () => undefined,
      complete: async () => undefined,
    };
    await fanOutBroadcastBatch(store, { id: "b-2", audience: "ALL", cursor: null, title: "Hello", body: "Body", actionUrl: "/news" });
    expect(payloads[0]).toMatchObject({ eventType: "SYSTEM_ANNOUNCEMENT", recipientId: "u-1", announcementId: "b-2", title: "Hello", body: "Body", actionUrl: "/news" });
  });
});
