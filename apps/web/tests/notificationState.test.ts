import assert from "node:assert/strict";
import { notificationReducer, initialNotificationState } from "../src/components/notifications/notificationState";

const item = (id: string, readAt: string | null = null) => ({
  id, type: "MESSAGE_RECEIVED", category: "MESSAGES" as const, title: id, body: "body",
  actionUrl: null, metadata: {}, readAt, createdAt: "2026-08-24T00:00:00Z",
});

assert.deepEqual(notificationReducer(initialNotificationState, { type: "HYDRATE", items: [item("a")], unreadCount: 1, nextCursor: "cursor-1" }), {
  ...initialNotificationState, items: [item("a")], unreadCount: 1, nextCursor: "cursor-1",
});
assert.equal(notificationReducer({ ...initialNotificationState, unreadCount: 1 }, { type: "SIGNAL_COUNT", unreadCount: -4 }).unreadCount, 0);

const hydrated = notificationReducer(initialNotificationState, { type: "HYDRATE", items: [item("a"), item("b")], unreadCount: 2, nextCursor: null });
const readOptimistic = notificationReducer(hydrated, { type: "MARK_READ_OPTIMISTIC", id: "a" });
assert.equal(readOptimistic.items[0].readAt, "optimistic");
assert.equal(readOptimistic.unreadCount, 1);
assert.deepEqual(notificationReducer(readOptimistic, { type: "MARK_READ_ROLLBACK", previous: hydrated }), hydrated);

const allRead = notificationReducer(hydrated, { type: "MARK_ALL" });
assert.equal(allRead.unreadCount, 0);
assert.ok(allRead.items.every((entry) => entry.readAt));

const removed = notificationReducer(hydrated, { type: "DELETE_OPTIMISTIC", id: "a" });
assert.equal(removed.items.length, 1);
assert.equal(removed.unreadCount, 1);
assert.deepEqual(notificationReducer(removed, { type: "DELETE_ROLLBACK", previous: hydrated }), hydrated);
assert.deepEqual(notificationReducer(hydrated, { type: "LOGOUT" }), initialNotificationState);

const pageTwo = notificationReducer(hydrated, {
  type: "APPEND_PAGE", items: [item("a"), item("c"), item("c")], nextCursor: "next-page",
});
assert.deepEqual(pageTwo.items.map((entry) => entry.id), ["a", "b", "c"]);
const pageTwoRead = notificationReducer(pageTwo, { type: "MARK_READ_OPTIMISTIC", id: "c" });
assert.equal(pageTwoRead.items[2].readAt, "optimistic");
assert.equal(pageTwoRead.unreadCount, 1);
const pageTwoDeleted = notificationReducer(pageTwo, { type: "DELETE_OPTIMISTIC", id: "c" });
assert.deepEqual(pageTwoDeleted.items.map((entry) => entry.id), ["a", "b"]);
assert.equal(pageTwoDeleted.unreadCount, 1);
assert.equal(pageTwoDeleted.nextCursor, "next-page");
