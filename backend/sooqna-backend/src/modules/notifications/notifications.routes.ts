import { Router } from "express";
import { requireActiveUser, requireCurrentUser } from "../../middleware/authContext";
import { asyncHandler } from "../../middleware/asyncHandler";
import { requireVerifiedEmail } from "../../middleware/requireVerifiedEmail";
import { validateRequest } from "../../middleware/validateRequest";
import { verifyFirebaseToken } from "../../middleware/verifyFirebaseToken";
import { notificationListQuerySchema, notificationPathParamsSchema, notificationPreferencesUpdateBodySchema } from "./notifications.schemas";
import { createNotificationStreamHandler, deleteNotification, getNotificationPreferences, getUnreadCount, listNotifications, markAllNotificationsRead, markNotificationRead, streamNotifications, updateNotificationPreferences } from "./notifications.controller";
import { NotificationBroker } from "./notifications.broker";

const productionController = { listNotifications, getUnreadCount, markNotificationRead, markAllNotificationsRead, deleteNotification, getNotificationPreferences, updateNotificationPreferences };
export function createNotificationsRouter(controller = productionController, broker?: NotificationBroker) {
  const router = Router(); router.use(verifyFirebaseToken, requireCurrentUser, requireActiveUser, requireVerifiedEmail);
  router.get("/", validateRequest({ query: notificationListQuerySchema }), asyncHandler(controller.listNotifications)); router.get("/unread-count", asyncHandler(controller.getUnreadCount)); router.get("/stream", asyncHandler(broker ? createNotificationStreamHandler(broker) : streamNotifications)); router.post("/read-all", asyncHandler(controller.markAllNotificationsRead)); router.get("/preferences", asyncHandler(controller.getNotificationPreferences)); router.put("/preferences", validateRequest({ body: notificationPreferencesUpdateBodySchema }), asyncHandler(controller.updateNotificationPreferences)); router.patch("/:notificationId/read", validateRequest({ params: notificationPathParamsSchema }), asyncHandler(controller.markNotificationRead)); router.delete("/:notificationId", validateRequest({ params: notificationPathParamsSchema }), asyncHandler(controller.deleteNotification)); return router;
}
export const notificationsRouter = createNotificationsRouter();
