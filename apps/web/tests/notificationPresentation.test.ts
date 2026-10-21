import assert from "node:assert/strict";
import {
  badgeLabel,
  formatRelativeNotificationTime,
  getNotificationPresentation,
  safeNotificationActionUrl,
} from "../src/components/notifications/notificationPresentation";

const now = new Date("2026-08-24T12:00:00.000Z");

assert.deepEqual(getNotificationPresentation("MESSAGE_RECEIVED"), {
  icon: "message",
  label: "رسالة جديدة",
  color: "brand",
});
assert.deepEqual(getNotificationPresentation("UNKNOWN"), {
  icon: "bell",
  label: "إشعار",
  color: "neutral",
});
assert.equal(badgeLabel(0), null);
assert.equal(badgeLabel(4), "4");
assert.equal(badgeLabel(100), "99+");
assert.equal(formatRelativeNotificationTime("2026-08-24T11:59:30.000Z", now), "الآن");
assert.equal(formatRelativeNotificationTime("2026-08-24T11:40:00.000Z", now), "منذ 20 دقيقة");
assert.equal(formatRelativeNotificationTime("2026-08-23T12:00:00.000Z", now), "منذ يوم");
assert.equal(safeNotificationActionUrl("/listings/123"), "/listings/123");
assert.equal(safeNotificationActionUrl("//evil.example"), null);
assert.equal(safeNotificationActionUrl("https://evil.example"), null);
assert.equal(safeNotificationActionUrl(null), null);

console.log("notification presentation tests passed");
