import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireActiveUser, requireCurrentUser } from "../../middleware/authContext";
import { asyncHandler } from "../../middleware/asyncHandler";
import { requireVerifiedEmail } from "../../middleware/requireVerifiedEmail";
import { validateRequest } from "../../middleware/validateRequest";
import { verifyFirebaseToken } from "../../middleware/verifyFirebaseToken";
import { notificationListQuerySchema, notificationPathParamsSchema, notificationPreferencesUpdateBodySchema } from "./notifications.schemas";
import { createNotificationStreamHandler, deleteNotification, getNotificationPreferences, getUnreadCount, listNotifications, markAllNotificationsRead, markNotificationRead, streamNotifications, updateNotificationPreferences } from "./notifications.controller";
import { NotificationBroker } from "./notifications.broker";
import { createRateLimitHandler } from "../../middleware/rateLimitHandler";

const productionController = { listNotifications, getUnreadCount, markNotificationRead, markAllNotificationsRead, deleteNotification, getNotificationPreferences, updateNotificationPreferences };
export function createNotificationsRouter(controller = productionController, broker?: NotificationBroker) {
  const router = Router(); router.use(verifyFirebaseToken, requireCurrentUser, requireActiveUser, requireVerifiedEmail);
  router.use(rateLimit({ windowMs: 5 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.currentUser?.firebaseUid ?? req.ip ?? "unknown", skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS", message: { success: false, code: "RATE_LIMITED", message: "Too many notification updates." }, handler: createRateLimitHandler("notifications-write", { success: false, code: "RATE_LIMITED", message: "Too many notification updates." }) }));
  router.get("/", validateRequest({ query: notificationListQuerySchema }), asyncHandler(controller.listNotifications)); router.get("/unread-count", asyncHandler(controller.getUnreadCount)); router.get("/stream", asyncHandler(broker ? createNotificationStreamHandler(broker) : streamNotifications)); router.post("/read-all", asyncHandler(controller.markAllNotificationsRead)); router.get("/preferences", asyncHandler(controller.getNotificationPreferences)); router.put("/preferences", validateRequest({ body: notificationPreferencesUpdateBodySchema }), asyncHandler(controller.updateNotificationPreferences)); router.patch("/:notificationId/read", validateRequest({ params: notificationPathParamsSchema }), asyncHandler(controller.markNotificationRead)); router.delete("/:notificationId", validateRequest({ params: notificationPathParamsSchema }), asyncHandler(controller.deleteNotification)); return router;
}
export const notificationsRouter = createNotificationsRouter();
