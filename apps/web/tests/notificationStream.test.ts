import assert from "node:assert/strict";
import { SseParser, reconnectDelay, shouldConnect } from "../src/components/notifications/notificationStream";

const signal = { event: "notification.changed" as const, notificationId: "n1", unreadCount: 2, version: 1 as const };

const parser = new SseParser();
assert.deepEqual(parser.push(": heartbeat\n\n"), []);
assert.deepEqual(parser.push("event: notification.changed\ndata: {\"event\":\"notification.changed\",\"notificationId\":\"n1\",\"unreadCount\":2,"), []);
assert.deepEqual(parser.push("\"version\":1}\n\n"), [signal]);
assert.deepEqual(parser.push("data: {bad}\n\n"), []);
assert.deepEqual(parser.push("event: other\ndata: {\"event\":\"notification.changed\",\"notificationId\":\"n2\",\"unreadCount\":1,\"version\":1}\n\n"), []);

assert.equal(reconnectDelay(0, () => 0), 1000);
assert.equal(reconnectDelay(10, () => 0), 30000);
assert.equal(reconnectDelay(0, () => 0.999), 1499);
assert.equal(shouldConnect({ user: { uid: "u1" }, visibilityState: "visible", online: true }), true);
assert.equal(shouldConnect({ user: { uid: "u1" }, visibilityState: "hidden", online: true }), false);
assert.equal(shouldConnect({ user: null, visibilityState: "visible", online: true }), false);
assert.equal(shouldConnect({ user: { uid: "u1" }, visibilityState: "visible", online: false }), false);

console.log("notificationStream tests passed");
