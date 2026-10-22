import { expect, test, type Page } from "@playwright/test";

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const authenticated = Boolean(email && password);
const firebaseConfigured = Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY);

async function signIn(page: Page) {
  if (!email || !password) throw new Error("Set E2E_EMAIL and E2E_PASSWORD to run authenticated notification journeys");
  await page.goto("/login");
  await page.getByLabel("البريد الإلكتروني").fill(email);
  await page.getByLabel("كلمة المرور").fill(password);
  await page.getByRole("button", { name: /تسجيل الدخول/ }).click();
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/, { timeout: 20_000 });
}

async function stubNotificationApi(page: Page, item: { id: string; title: string; body: string; actionUrl: string }) {
  await page.route("**/api/notifications/stream", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" });
  });
  await page.route("**/api/notifications/unread-count", async (route) => {
    await route.fulfill({ json: { success: true, data: { unreadCount: 1 } } });
  });
  await page.route("**/api/notifications?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { items: [{ id: item.id, type: "MESSAGE_RECEIVED", category: "MESSAGES", title: item.title, body: item.body, actionUrl: item.actionUrl, metadata: {}, readAt: null, createdAt: new Date().toISOString() }], nextCursor: null, hasMore: false } }),
    });
  });
  await page.route(`**/api/notifications/${item.id}/read`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { updated: 1 } }) });
  });
}

test("signed-out users are redirected away from the notification center", async ({ page }) => {
  test.skip(!firebaseConfigured, "requires the web Firebase environment to be configured");
  await page.goto("/notifications");
  await expect(page).toHaveURL(/\/login\?next=%2Fnotifications/);
});

test("message notification opens the conversation and marks itself read", async ({ page }) => {
  test.skip(!authenticated, "requires E2E_EMAIL and E2E_PASSWORD Firebase credentials");
  const item = { id: "e2e-message-1", title: "رسالة جديدة", body: "مرحباً، هذا نص معاينة آمن", actionUrl: "/messages?conversation=e2e-conversation" };
  await stubNotificationApi(page, item);
  await signIn(page);
  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-popover")).toBeVisible();
  await expect(page.getByTestId(`notification-item-${item.id}`)).toContainText(item.body);
  await expect(page.getByTestId("notification-count")).toHaveText("1");
  const markReadRequest = page.waitForRequest((request) => request.url().includes(`/api/notifications/${item.id}/read`) && request.method() === "PATCH");
  await Promise.all([markReadRequest, page.getByTestId(`notification-item-${item.id}`).getByRole("button", { name: item.title }).click()]);
  await expect(page).toHaveURL(/\/messages\?conversation=e2e-conversation/);
});

test("moderation notification uses safe copy and internal listing action", async ({ page }) => {
  test.skip(!authenticated, "requires E2E_EMAIL and E2E_PASSWORD Firebase credentials");
  const item = { id: "e2e-moderation-1", title: "تم قبول إعلانك", body: "تمت الموافقة على إعلانك ونشره في السوق.", actionUrl: "/listings/e2e-listing" };
  await stubNotificationApi(page, item);
  await signIn(page);
  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId(`notification-item-${item.id}`)).toContainText("تم قبول إعلانك");
  await page.getByTestId(`notification-item-${item.id}`).getByRole("button", { name: item.title }).click();
  await expect(page).toHaveURL(/\/listings\/e2e-listing$/);
});

test("moderation rejection notification shows the safe reason summary", async ({ page }) => {
  test.skip(!authenticated, "requires E2E_EMAIL and E2E_PASSWORD Firebase credentials");
  const item = { id: "e2e-moderation-rejection-1", title: "تعذر نشر إعلانك", body: "السبب: معلومات الإعلان تحتاج إلى مراجعة.", actionUrl: "/listings/e2e-listing" };
  await stubNotificationApi(page, item);
  await signIn(page);
  await page.getByTestId("notification-bell").click();
  const notification = page.getByTestId(`notification-item-${item.id}`);
  await expect(notification).toContainText("تعذر نشر إعلانك");
  await expect(notification).toContainText("معلومات الإعلان تحتاج إلى مراجعة");
  await notification.getByRole("button", { name: item.title }).click();
  await expect(page).toHaveURL(/\/listings\/e2e-listing$/);
});
