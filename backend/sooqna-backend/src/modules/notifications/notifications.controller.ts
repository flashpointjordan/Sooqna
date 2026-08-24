import type { Request, Response } from "express";
import { AppError } from "../../shared/errors/appError";
import { sendSuccess } from "../../shared/contracts/api";
import { PrismaNotificationsRepository } from "./notifications.repository";
import { notificationListQuerySchema } from "./notifications.schemas";
import { NotificationsService } from "./notifications.service";

const service = new NotificationsService(new PrismaNotificationsRepository());

function userId(req: Request): string {
  const value = req.currentUser?.firebaseUid ?? req.authUser?.uid;
  if (!value) throw new AppError(401, "Unauthorized.", "UNAUTHORIZED");
  return value;
}
function notificationId(req: Request): string { return req.params.notificationId; }

export async function listNotifications(req: Request, res: Response): Promise<void> { sendSuccess(res, await service.list(userId(req), notificationListQuerySchema.parse(req.query))); }
export async function getUnreadCount(req: Request, res: Response): Promise<void> { sendSuccess(res, { unreadCount: await service.unreadCount(userId(req)) }); }
export async function markNotificationRead(req: Request, res: Response): Promise<void> { sendSuccess(res, await service.markRead(userId(req), notificationId(req))); }
export async function markAllNotificationsRead(req: Request, res: Response): Promise<void> { sendSuccess(res, await service.markAllRead(userId(req))); }
export async function deleteNotification(req: Request, res: Response): Promise<void> { sendSuccess(res, await service.delete(userId(req), notificationId(req))); }
export async function getNotificationPreferences(req: Request, res: Response): Promise<void> { sendSuccess(res, await service.getPreferences(userId(req))); }
export async function updateNotificationPreferences(req: Request, res: Response): Promise<void> { sendSuccess(res, await service.updatePreferences(userId(req), req.body)); }
