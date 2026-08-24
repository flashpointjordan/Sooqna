import type { Request, Response } from "express";
import { AppError } from "../../shared/errors/appError";
import { sendSuccess } from "../../shared/contracts/api";
import { PrismaNotificationsRepository } from "./notifications.repository";
import { notificationListQuerySchema } from "./notifications.schemas";
import { NotificationsService } from "./notifications.service";

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
