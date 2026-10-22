import assert from "node:assert/strict";

const calls: Array<{ url: string; method: string; body?: string }> = [];
const originalFetch = globalThis.fetch;
const prefs = { MESSAGES: false, LISTINGS: true, ENGAGEMENT: true, SAVED_SEARCHES: true, SYSTEM: true, SECURITY: true };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
  const data = url.includes("/preferences") ? prefs
    : url.includes("/unread-count") ? { unreadCount: 4 }
    : url.includes("/read") ? { updated: 1 }
    : { items: [], nextCursor: "cursor-2", hasMore: true };
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

(async () => {
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "test-key";
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = "test.firebaseapp.com";
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = "test";
  process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = "1";
  process.env.NEXT_PUBLIC_FIREBASE_APP_ID = "1:1:web:test";
  const { notificationApi } = await import("../src/services/notificationService");
  const page = await notificationApi.list({ limit: 20, cursor: "cursor-1" });
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, "cursor-2");
  assert.equal(page.unreadCount, 4);
  assert.equal((await notificationApi.unreadCount()).unreadCount, 4);
  await notificationApi.markRead("n/1");
  await notificationApi.markAllRead();
  await notificationApi.remove("n1");
  assert.deepEqual((await notificationApi.getPreferences()).preferences, prefs);
  assert.deepEqual((await notificationApi.preferences(prefs)).preferences, prefs);
  assert.equal(calls.find((call) => call.url.endsWith("/n%2F1/read"))?.method, "PATCH");
  const update = calls.find((call) => call.method === "PUT");
  assert.deepEqual(JSON.parse(update?.body ?? "null"), {
    MESSAGES: false, LISTINGS: true, ENGAGEMENT: true, SAVED_SEARCHES: true,
  });
  assert(calls.some((call) => call.method === "POST" && call.url.endsWith("/read-all")));
  assert(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/n1")));
  console.log("notification API contract tests passed");
})().finally(() => { globalThis.fetch = originalFetch; });
