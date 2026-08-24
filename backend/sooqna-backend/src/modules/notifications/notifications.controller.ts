import type { Request, Response } from "express";
import { AppError } from "../../shared/errors/appError";
import { sendSuccess } from "../../shared/contracts/api";
import { PrismaNotificationsRepository } from "./notifications.repository";
import { notificationListQuerySchema } from "./notifications.schemas";
import { NotificationsService } from "./notifications.service";
import { getNotificationBroker, NotificationBroker } from "./notifications.broker";

export type NotificationsControllerService = Pick<NotificationsService, "list" | "unreadCount" | "markRead" | "markAllRead" | "delete" | "getPreferences" | "updatePreferences">;
const service = new NotificationsService(new PrismaNotificationsRepository());

function userId(req: Request): string {
  const value = req.currentUser?.firebaseUid ?? req.authUser?.uid;
  if (!value) throw new AppError(401, "Unauthorized.", "UNAUTHORIZED");
  return value;
}
function notificationId(req: Request): string { return req.params.notificationId; }

export function createNotificationsController(service: NotificationsControllerService) {
  return {
    async listNotifications(req: Request, res: Response): Promise<void> { sendSuccess(res, await service.list(userId(req), notificationListQuerySchema.parse(req.query))); },
    async getUnreadCount(req: Request, res: Response): Promise<void> { sendSuccess(res, { unreadCount: await service.unreadCount(userId(req)) }); },
    async markNotificationRead(req: Request, res: Response): Promise<void> { sendSuccess(res, await service.markRead(userId(req), notificationId(req))); },
    async markAllNotificationsRead(req: Request, res: Response): Promise<void> { sendSuccess(res, await service.markAllRead(userId(req))); },
    async deleteNotification(req: Request, res: Response): Promise<void> { sendSuccess(res, await service.delete(userId(req), notificationId(req))); },
    async getNotificationPreferences(req: Request, res: Response): Promise<void> { sendSuccess(res, await service.getPreferences(userId(req))); },
    async updateNotificationPreferences(req: Request, res: Response): Promise<void> { sendSuccess(res, await service.updatePreferences(userId(req), req.body)); },
  };
}
export const { listNotifications, getUnreadCount, markNotificationRead, markAllNotificationsRead, deleteNotification, getNotificationPreferences, updateNotificationPreferences } = createNotificationsController(service);

export function createNotificationStreamHandler(broker: Pick<NotificationBroker, "subscribe" | "activeCount">) {
  return async (req: Request, res: Response): Promise<void> => {
    const uid = userId(req);
    if (broker.activeCount(uid) >= 3) throw new AppError(429, "Too many notification streams.", "TOO_MANY_STREAMS");
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write("retry: 5000\n\n");
    const unsubscribe = broker.subscribe(uid, res);
    let cleaned = false;
    let heartbeat: NodeJS.Timeout | undefined;
    const onAbort = () => cleanup();
    const onRequestClose = () => cleanup();
    const onResponseClose = () => cleanup();
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      req.off("aborted", onAbort);
      req.off("close", onRequestClose);
      res.off("close", onResponseClose);
    };
    heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); }
      catch { cleanup(); }
    }, 25_000);
    heartbeat.unref();
    req.once("aborted", onAbort);
    req.once("close", onRequestClose);
    res.once("close", onResponseClose);
  };
}
export async function streamNotifications(req: Request, res: Response): Promise<void> {
  await createNotificationStreamHandler(getNotificationBroker())(req, res);
}
