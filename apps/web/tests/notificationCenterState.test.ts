import assert from "node:assert/strict";
import {
  appendNotificationPage,
  filterNotificationItems,
  groupNotificationItems,
  mergeNotificationPreferences,
  type CenterNotificationItem,
} from "../src/components/notifications/notificationCenterState";

const items: CenterNotificationItem[] = [
  { id: "1", type: "MESSAGE_RECEIVED", category: "MESSAGES", title: "رسالة", body: "نص", actionUrl: null, metadata: {}, readAt: null, createdAt: "2026-08-24T11:00:00.000Z" },
  { id: "2", type: "LISTING_APPROVED", category: "LISTINGS", title: "تم النشر", body: "نص", actionUrl: null, metadata: {}, readAt: "2026-08-24T10:00:00.000Z", createdAt: "2026-08-23T11:00:00.000Z" },
  { id: "3", type: "SECURITY_ALERT", category: "SECURITY", title: "أمان", body: "نص", actionUrl: "/me/settings", metadata: {}, readAt: null, createdAt: "2026-08-20T11:00:00.000Z" },
];

assert.deepEqual(filterNotificationItems(items, { category: "MESSAGES", unreadOnly: false }).map((item) => item.id), ["1"]);
assert.deepEqual(filterNotificationItems(items, { category: "ALL", unreadOnly: true }).map((item) => item.id), ["1", "3"]);
assert.deepEqual(groupNotificationItems(items, new Date("2026-08-24T12:00:00.000Z")), {
  today: [items[0]],
  yesterday: [items[1]],
  earlier: [items[2]],
});
assert.deepEqual(appendNotificationPage([items[0]], [items[0], items[1]]), [items[0], items[1]]);
assert.deepEqual(mergeNotificationPreferences({ MESSAGES: true, LISTINGS: false }, { MESSAGES: false }), { MESSAGES: false, LISTINGS: false, SYSTEM: true, SECURITY: true });
assert.deepEqual(mergeNotificationPreferences({ SYSTEM: false, SECURITY: false }, { SYSTEM: false, SECURITY: true }), { SYSTEM: true, SECURITY: true });

console.log("notification center state tests passed");
