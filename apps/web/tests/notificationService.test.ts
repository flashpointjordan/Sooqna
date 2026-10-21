import assert from "node:assert/strict";
const calls: Array<{ url: string; method: string }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), method: init?.method ?? "GET" });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

(async () => {
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "test-key";
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = "test.firebaseapp.com";
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = "test";
  process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = "1";
  process.env.NEXT_PUBLIC_FIREBASE_APP_ID = "1:1:web:test";
  const { notificationApi } = await import("../src/services/notificationService");
  await notificationApi.list({ limit: 10 });
  await notificationApi.unreadCount();
  await notificationApi.markRead("n1");
  await notificationApi.markAllRead();
  await notificationApi.remove("n1");
  await notificationApi.preferences({ MESSAGES: false });

assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
  "GET /api/notifications",
  "GET /api/notifications/unread-count",
  "POST /api/notifications/n1/read",
  "POST /api/notifications/read-all",
  "DELETE /api/notifications/n1",
  "PUT /api/notifications/preferences",
]);
  globalThis.fetch = originalFetch;
  console.log("notificationService tests passed");
})().catch((error) => {
  globalThis.fetch = originalFetch;
  throw error;
});
