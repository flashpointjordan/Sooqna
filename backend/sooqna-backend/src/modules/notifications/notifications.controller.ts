import type { Request, Response } from "express";
import { AppError } from "../../shared/errors/appError";
import { sendSuccess } from "../../shared/contracts/api";
import { PrismaNotificationsRepository } from "./notifications.repository";
import { notificationListQuerySchema } from "./notifications.schemas";
import { NotificationsService, type NotificationsRepository } from "./notifications.service";
import { getNotificationBroker, type NotificationPublisher, NotificationBroker, publishNotificationSignal } from "./notifications.broker";
import { logger } from "../../config/logger";

export type NotificationsControllerService = Pick<NotificationsService, "list" | "unreadCount" | "markRead" | "markAllRead" | "delete" | "getPreferences" | "updatePreferences">;
type ProductionServiceOptions = { publisher?: NotificationPublisher; logger?: Pick<typeof logger, "warn"> };
export function createProductionNotificationsService(repository: NotificationsRepository, options: ProductionServiceOptions = {}): NotificationsService {
  const publisher = options.publisher ?? publishNotificationSignal;
  const productionLogger = options.logger ?? logger;
  return new NotificationsService(repository, { publishSignal: async (userId, notificationId, unreadCount) => {
    try { await publisher(userId, notificationId, unreadCount); }
    catch (error) { productionLogger.warn("notification_signal_publish_failed", { notificationId, error: error instanceof Error ? error.message : String(error) }); }
  } });
}
const service = createProductionNotificationsService(new PrismaNotificationsRepository());

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

export function createNotificationStreamHandler(broker: Pick<NotificationBroker, "subscribe" | "activeCount" | "isClosing" | "registerCleanup">) {
  return async (req: Request, res: Response): Promise<void> => {
    const uid = req.currentUser?.firebaseUid;
    if (!uid) throw new AppError(401, "Unauthorized.", "UNAUTHORIZED");
    if (broker.isClosing()) throw new AppError(503, "Notification streaming is shutting down.", "SHUTTING_DOWN");
    if (broker.activeCount(uid) >= 3) throw new AppError(429, "Too many notification streams.", "TOO_MANY_STREAMS");
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    if (!res.write("retry: 5000\n\n")) { res.end(); return; }
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
    broker.registerCleanup(res, cleanup);
    heartbeat = setInterval(() => {
      try { if (!res.write(": heartbeat\n\n")) { res.end(); cleanup(); } }
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
