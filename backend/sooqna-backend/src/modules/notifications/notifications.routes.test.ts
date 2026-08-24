import express from "express";
import request from "supertest";
import { errorHandler } from "../../middleware/errorHandler";

jest.mock("../../middleware/verifyFirebaseToken", () => ({
  verifyFirebaseToken(req: { get(name: string): string | undefined; authUser?: unknown }, res: express.Response, next: express.NextFunction) {
    if (req.get("authorization") !== "Bearer test-token") { res.status(401).json({ success: false, code: "UNAUTHORIZED" }); return; }
    req.authUser = { uid: req.get("x-user-id") ?? "user-a", email_verified: req.get("x-verified") !== "false" };
    next();
  },
}));
jest.mock("../../middleware/authContext", () => ({
  requireCurrentUser(req: { authUser?: { uid?: string; email_verified?: boolean }; currentUser?: unknown }, _res: express.Response, next: express.NextFunction) {
    req.currentUser = { firebaseUid: req.authUser?.uid, emailVerified: req.authUser?.email_verified, accountStatus: "active" };
    next();
  },
  requireActiveUser(_req: express.Request, _res: express.Response, next: express.NextFunction) { next(); },
}));
jest.mock("../../middleware/requireVerifiedEmail", () => ({
  requireVerifiedEmail(req: { authUser?: { email_verified?: boolean } }, res: express.Response, next: express.NextFunction) {
    if (!req.authUser?.email_verified) { res.status(403).json({ success: false, code: "EMAIL_NOT_VERIFIED" }); return; }
    next();
  },
}));
jest.mock("./notifications.repository", () => ({ PrismaNotificationsRepository: class {} }));
import { notificationListQuerySchema, notificationPreferencesUpdateBodySchema } from "./notifications.schemas";
import { createNotificationsController } from "./notifications.controller";
import { createNotificationsRouter } from "./notifications.routes";
import type { NotificationsControllerService } from "./notifications.controller";
import type { NotificationDto } from "./notifications.types";

const notification = (id: string): NotificationDto => ({ id, type: "LISTING_APPROVED", category: "LISTINGS", title: "title", body: "body", actionUrl: null, entityType: null, entityId: null, metadata: {}, readAt: null, createdAt: "2026-08-24T12:00:00.000Z" });
const fakeService: NotificationsControllerService = {
  list: async () => ({ items: [], hasMore: false, nextCursor: null }), unreadCount: async () => 3,
  markRead: async (_userId, id) => { if (id === "other") throw new (require("../../shared/errors/appError").AppError)(404, "Notification not found.", "NOT_FOUND"); return notification(id); },
  markAllRead: async () => ({ updatedCount: 2, unreadCount: 1 }), delete: async (_userId, id) => { if (id === "other") throw new (require("../../shared/errors/appError").AppError)(404, "Notification not found.", "NOT_FOUND"); return notification(id); },
  getPreferences: async () => ({ MESSAGES: true, LISTINGS: true, ENGAGEMENT: true, SAVED_SEARCHES: true, SYSTEM: true, SECURITY: true }), updatePreferences: async () => ({ MESSAGES: false, LISTINGS: true, ENGAGEMENT: true, SAVED_SEARCHES: true, SYSTEM: true, SECURITY: true }),
};
function testApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/notifications", createNotificationsRouter(createNotificationsController(fakeService)));
  app.use(errorHandler);
  return app;
}
const auth = { Authorization: "Bearer test-token" };

describe("notification REST route contract", () => {
  it("accepts bounded notification list and optional-only preference inputs", () => {
    expect(notificationListQuerySchema.parse({ limit: "50", category: "MESSAGES", unread: "true" })).toMatchObject({ limit: 50, category: "MESSAGES", unread: true });
    expect(notificationListQuerySchema.safeParse({ userId: "someone-else" }).success).toBe(false);
    expect(notificationListQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(notificationPreferencesUpdateBodySchema.parse({ MESSAGES: false })).toEqual({ MESSAGES: false });
    expect(notificationPreferencesUpdateBodySchema.safeParse({ SYSTEM: false }).success).toBe(false);
  });

  it("registers fixed routes before parameterized notification IDs", () => {
    const router = createNotificationsRouter(createNotificationsController(fakeService)); const paths = router.stack.map((layer) => layer.route?.path).filter(Boolean);
    expect(paths).toEqual(["/", "/unread-count", "/stream", "/read-all", "/preferences", "/preferences", "/:notificationId/read", "/:notificationId"]);
    expect(router.stack.slice(0, 4).map((layer) => layer.handle.name)).toEqual(["verifyFirebaseToken", "requireCurrentUser", "requireActiveUser", "requireVerifiedEmail"]);
  });

  it("rejects unauthenticated and unverified requests before reaching controllers", async () => {
    await request(testApp()).get("/api/notifications").expect(401).expect({ success: false, code: "UNAUTHORIZED" });
    await request(testApp()).get("/api/notifications").set({ ...auth, "x-verified": "false" }).expect(403).expect({ success: false, code: "EMAIL_NOT_VERIFIED" });
  });

  it("returns validation errors for invalid list, ID, and preference input", async () => {
    await request(testApp()).get("/api/notifications?limit=51").set(auth).expect(400);
    await request(testApp()).get("/api/notifications?userId=someone-else").set(auth).expect(400);
    await request(testApp()).patch(`/api/notifications/${"x".repeat(129)}/read`).set(auth).expect(400);
    await request(testApp()).put("/api/notifications/preferences").set(auth).send({ SYSTEM: false }).expect(400);
  });

  it("does not leak cross-user read or delete through HTTP", async () => {
    await request(testApp()).patch("/api/notifications/other/read").set(auth).expect(404).expect("Content-Type", /json/);
    await request(testApp()).delete("/api/notifications/other").set(auth).expect(404).expect("Content-Type", /json/);
  });

  it("serves list, count, read-all, and preferences using standard data envelopes", async () => {
    await request(testApp()).get("/api/notifications").set(auth).expect(200, { success: true, data: { items: [], hasMore: false, nextCursor: null } });
    await request(testApp()).get("/api/notifications/unread-count").set(auth).expect(200, { success: true, data: { unreadCount: 3 } });
    await request(testApp()).post("/api/notifications/read-all").set(auth).expect(200, { success: true, data: { updatedCount: 2, unreadCount: 1 } });
    await request(testApp()).get("/api/notifications/preferences").set(auth).expect(200).expect((response) => expect(response.body.data.SYSTEM).toBe(true));
    await request(testApp()).put("/api/notifications/preferences").set(auth).send({ MESSAGES: false }).expect(200).expect((response) => expect(response.body.data.MESSAGES).toBe(false));
  });
});
