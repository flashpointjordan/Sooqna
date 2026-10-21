export type NotificationCategory = "MESSAGES" | "LISTINGS" | "ENGAGEMENT" | "SAVED_SEARCHES" | "SYSTEM" | "SECURITY";

export type NotificationItemDto = {
  id: string;
  type: string;
  category: NotificationCategory;
  title: string;
  body: string;
  actionUrl: string | null;
  metadata: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

export type NotificationSignal = {
  event: "notification.changed";
  notificationId: string;
  unreadCount: number;
  version: 1;
};
